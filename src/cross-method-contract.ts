import { dirname } from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import { descendants, parseGo, sourceText } from "./parser.js";
import type { Signal, SourceRevision } from "./types.js";

interface PolicyMethod {
  method: string;
  line: number;
  changed: boolean;
}

export interface PolicyGroupEvidence {
  key: string;
  directory: string;
  helper: string;
  receiverType: string;
  methods: PolicyMethod[];
}

export interface ContractTestEvidence {
  directory: string;
  path: string;
  source: string;
  status: SourceRevision["status"];
  changedLines: Set<number>;
  name: string;
  normalizedName: string;
  line: number;
  anchors: number[];
  calls: Set<string>;
  hasOracle: boolean;
}

/**
 * Collect a repeated, changed production gate only when at least three exported
 * sibling methods on the same receiver call the same receiver helper from an
 * if-condition that returns on failure. This is evidence of a per-entrypoint
 * contract, not a generic request for more coverage.
 */
export async function policyGroupEvidence(file: SourceRevision, tree: Tree): Promise<PolicyGroupEvidence[]> {
  if (!eligibleSource(file) || file.path.endsWith("_test.go") || file.status === "repository" || file.status === "context") return [];
  const current = collectPolicyGroups(file, tree);
  if (file.status === "modified" && file.previous === undefined) return [];
  if (file.previous === undefined) return current;

  let previousTree: Tree | undefined;
  try {
    previousTree = await parseGo(file.previous);
    if (previousTree.rootNode.hasError) return [];
    const previous = collectPolicyGroups({
      path: file.path,
      current: file.previous,
      changedLines: new Set(),
      status: "repository",
    }, previousTree, false);
    const priorMethods = new Set(previous.flatMap((group) =>
      group.methods.map((method) => `${group.key}\0${method.method}`)));
    return current.filter((group) => group.methods.some((method) =>
      method.changed && !priorMethods.has(`${group.key}\0${method.method}`)));
  } catch {
    return [];
  } finally {
    previousTree?.delete();
  }
}

function collectPolicyGroups(file: SourceRevision, tree: Tree, requireChanged = true): PolicyGroupEvidence[] {
  const grouped = new Map<string, Map<string, PolicyMethod>>();

  for (const method of descendants(tree.rootNode, "method_declaration")) {
    const nameNode = method.childForFieldName("name");
    const receiverNode = method.childForFieldName("receiver");
    const body = method.childForFieldName("body");
    if (nameNode === null || receiverNode === null || body === null) continue;
    const methodName = sourceText(nameNode, file.current);
    if (!/^[A-Z]/.test(methodName)) continue;
    const receiver = receiverBinding(sourceText(receiverNode, file.current));
    if (receiver === undefined) continue;

    for (const call of descendants(body, "call_expression")) {
      if (owningCallable(call)?.id !== method.id || !isReturningGate(call, method, file.current)) continue;
      const invoked = directReceiverMethod(call, receiver.name, file.current);
      if (invoked === undefined || invoked === methodName) continue;
      const line = call.startPosition.row + 1;
      const endLine = call.endPosition.row + 1;
      const callChanged = changed(file, line, endLine);
      const key = `${dirname(file.path)}\0${receiver.type}\0${invoked}`;
      const methods = grouped.get(key) ?? new Map<string, PolicyMethod>();
      methods.set(methodName, { method: methodName, line, changed: callChanged });
      grouped.set(key, methods);
    }
  }

  return [...grouped.entries()].flatMap(([key, methods]) => {
    const values = [...methods.values()].sort((left, right) => left.method.localeCompare(right.method));
    if (values.length < 3 || (requireChanged && !values.some((method) => method.changed))) return [];
    const [, receiverType, helper] = key.split("\0");
    return [{
      key,
      directory: dirname(file.path),
      helper: helper!,
      receiverType: receiverType!,
      methods: values,
    }];
  });
}

/** Collect behavioral test functions and the exported methods they execute. */
export function contractTestEvidence(file: SourceRevision, tree: Tree): ContractTestEvidence[] {
  if (!eligibleSource(file) || !file.path.endsWith("_test.go")) return [];
  const evidence: ContractTestEvidence[] = [];
  const callbackExecutors = provenCallbackExecutors(tree.rootNode, file.current);
  for (const fn of descendants(tree.rootNode, "function_declaration")) {
    const nameNode = fn.childForFieldName("name");
    const body = fn.childForFieldName("body");
    if (nameNode === null || body === null) continue;
    const name = sourceText(nameNode, file.current);
    if (!/^Test[A-Z0-9_]/.test(name)) continue;

    const calls = new Set<string>();
    const anchors: number[] = [nameNode.startPosition.row + 1];
    let hasOracle = false;
    for (const call of descendants(body, "call_expression")) {
      const callable = call.childForFieldName("function");
      if (callable === null) continue;
      if (executedByTest(call, fn, file.current, callbackExecutors)) {
        const field = selectorField(callable, file.current);
        if (field !== undefined && /^[A-Z]/.test(field)) {
          calls.add(field);
          anchors.push(call.startPosition.row + 1);
        }
      }
      if (isTestOracle(callable, file.current) && belongsToExecutedTestScope(call, fn, file.current, callbackExecutors)) {
        hasOracle = true;
        anchors.push(call.startPosition.row + 1);
      }
    }
    evidence.push({
      directory: dirname(file.path),
      path: file.path,
      source: file.current,
      status: file.status,
      changedLines: file.changedLines,
      name,
      normalizedName: normalizeIdentifier(name.replace(/^Test/, "")),
      line: nameNode.startPosition.row + 1,
      anchors: [...new Set(anchors)].sort((left, right) => left - right),
      calls,
      hasOracle,
    });
  }
  return evidence;
}

function belongsToExecutedTestScope(
  call: Node,
  test: Node,
  source: string,
  callbackExecutors: Map<string, Set<number>>,
): boolean {
  const owner = owningCallable(call);
  if (owner === undefined) return false;
  if (owner.id === test.id) return !precededByReturn(call, test);
  if (owner.type !== "func_literal") return false;
  return directlyInvokedFromTest(owner, test, source, callbackExecutors) ||
    invokedByProvenHelper(owner, test, source, callbackExecutors);
}

export function crossMethodContractSignals(
  groups: PolicyGroupEvidence[],
  tests: ContractTestEvidence[],
): Signal[] {
  const signals: Signal[] = [];
  for (const group of groups.sort((left, right) => left.key.localeCompare(right.key))) {
    const helper = normalizeIdentifier(group.helper);
    const relevant = tests.filter((test) =>
      test.directory === group.directory && test.hasOracle && test.normalizedName.includes(helper));
    if (relevant.length === 0) continue;

    const candidateMethods = new Set(group.methods.map((method) => method.method));
    const covered = new Set<string>();
    for (const test of relevant) {
      for (const call of test.calls) {
        if (candidateMethods.has(call)) covered.add(call);
      }
    }
    if (covered.size === 0 || covered.size === candidateMethods.size) continue;

    const presentation = relevant.flatMap((test) => test.anchors
      .filter((line) => test.status === "added" || test.status === "repository" || test.changedLines.has(line))
      .map((line) => ({ test, line })))
      .sort((left, right) => left.test.path.localeCompare(right.test.path) || left.line - right.line)[0];
    if (presentation === undefined || presentation.test.status === "context") continue;

    const missing = [...candidateMethods].filter((method) => !covered.has(method)).sort();
    const coveredList = [...covered].sort();
    signals.push({
      ruleId: "go-test.cross-method-contract-coverage",
      path: presentation.test.path,
      line: presentation.line,
      locality: { kind: "direct", anchors: [presentation.line] },
      message: `${presentation.test.name} exercises ${coveredList.join(", ")} for the ${group.helper} contract, but the same changed gate is also wired into ${missing.join(", ")} without behavioral coverage in this package.`,
      snippet: (presentation.test.source.split("\n")[presentation.line - 1] ?? "").trim().slice(0, 300),
      data: {
        helper: group.helper,
        receiverType: group.receiverType,
        coveredMethods: coveredList,
        missingMethods: missing,
      },
    });
  }
  return signals;
}

function receiverBinding(value: string): { name: string; type: string } | undefined {
  const match = value.trim().match(/^\(\s*([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?(?:\[[^\]]+\])?)\s*\)$/);
  return match === null ? undefined : { name: match[1]!, type: match[2]! };
}

function directReceiverMethod(call: Node, receiver: string, source: string): string | undefined {
  const callable = call.childForFieldName("function");
  if (callable === null || callable.type !== "selector_expression") return undefined;
  const operand = callable.childForFieldName("operand") ?? callable.namedChild(0);
  const field = callable.childForFieldName("field") ?? callable.namedChild(callable.namedChildCount - 1);
  if (operand === null || field === null || operand.type !== "identifier") return undefined;
  return sourceText(operand, source) === receiver ? sourceText(field, source) : undefined;
}

function isReturningGate(call: Node, owner: Node, source: string): boolean {
  for (let candidate = call.parent; candidate !== null && candidate.id !== owner.id; candidate = candidate.parent) {
    if (candidate.type !== "if_statement") continue;
    const consequence = candidate.childForFieldName("consequence");
    if (consequence === null || call.startIndex >= consequence.startIndex) return false;
    const header = source.slice(candidate.startIndex, consequence.startIndex);
    const assignment = header.match(/^\s*if\s+([A-Za-z_]\w*)\s*:=\s*[\s\S]*?;\s*\1\s*!=\s*nil\b/);
    if (assignment === null) return false;
    const statements = consequence.namedChildren.find((child) => child.type === "statement_list");
    return statements?.namedChildren.some((statement) => statement.type === "return_statement") ?? false;
  }
  return false;
}

function executedByTest(
  call: Node,
  test: Node,
  source: string,
  callbackExecutors: Map<string, Set<number>>,
): boolean {
  const owner = owningCallable(call);
  if (owner === undefined) return false;
  if (owner.id === test.id) return directlyWithinCallable(call, test, source);
  if (owner.type !== "func_literal") return false;
  if (!directlyWithinCallable(call, owner, source)) return false;
  if (directlyInvokedFromTest(owner, test, source, callbackExecutors)) return true;
  if (invokedByProvenHelper(owner, test, source, callbackExecutors)) return true;

  const keyed = ancestor(owner, "keyed_element", test);
  const loop = ancestor(owner, "for_statement", test);
  if (keyed === undefined || loop === undefined) return false;
  const key = sourceText(keyed, source).match(/^\s*([A-Za-z_]\w*)\s*:/)?.[1];
  if (key === undefined) return false;
  const body = loop.childForFieldName("body");
  return body !== null && descendants(body, "call_expression").some((invocation) => {
    const callable = invocation.childForFieldName("function");
    if (callable === null || selectorField(callable, source) !== key) return false;
    const invocationOwner = owningCallable(invocation);
    if (invocationOwner?.id === test.id) return directlyWithinLoop(invocation, loop);
    if (invocationOwner?.type !== "func_literal" || !directlyWithinCallable(invocation, invocationOwner, source)) return false;
    const runArgs = invocationOwner.parent;
    const runCall = runArgs?.type === "argument_list" ? runArgs.parent : undefined;
    if (runCall?.type !== "call_expression") return false;
    const runCallable = runCall.childForFieldName("function");
    return runCallable !== null && selectorField(runCallable, source) === "Run" && directlyWithinLoop(runCall, loop);
  });
}

function provenCallbackExecutors(root: Node, source: string): Map<string, Set<number>> {
  const executors = new Map<string, Set<number>>();
  const functions = descendants(root, "function_declaration");
  const nameCounts = new Map<string, number>();
  for (const fn of functions) {
    const nameNode = fn.childForFieldName("name");
    if (nameNode !== null) {
      const name = sourceText(nameNode, source);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  }
  for (const fn of functions) {
    const nameNode = fn.childForFieldName("name");
    const parameters = fn.childForFieldName("parameters");
    const body = fn.childForFieldName("body");
    if (nameNode === null || parameters === null || body === null) continue;
    const functionName = sourceText(nameNode, source);
    if (nameCounts.get(functionName) !== 1) continue;
    const callbackParameters: Array<{ name: string; index: number }> = [];
    let index = 0;
    for (const parameter of parameters.namedChildren) {
      if (parameter.type !== "parameter_declaration") continue;
      const text = sourceText(parameter, source).trim();
      const match = text.match(/^([A-Za-z_]\w*)\s+func\s*\(/);
      if (match !== null) callbackParameters.push({ name: match[1]!, index });
      index += 1;
    }
    for (const parameter of callbackParameters) {
      const invoked = descendants(body, "call_expression").some((call) => {
        if (owningCallable(call)?.id !== fn.id) return false;
        const callable = call.childForFieldName("function");
        return callable?.type === "identifier" && sourceText(callable, source) === parameter.name &&
          directlyWithinCallable(call, fn, source) &&
          !identifierAssignedBefore(fn, parameter.name, call.startIndex, source);
      });
      if (!invoked) continue;
      const indexes = executors.get(functionName) ?? new Set<number>();
      indexes.add(parameter.index);
      executors.set(functionName, indexes);
    }
  }
  return executors;
}

function directlyWithinCallable(node: Node, callable: Node, source: string): boolean {
  for (let candidate = node.parent; candidate !== null && candidate.id !== callable.id; candidate = candidate.parent) {
    if (candidate.type === "if_statement") {
      const consequence = candidate.childForFieldName("consequence");
      if (consequence !== null && node.endIndex <= consequence.startIndex) continue;
      return false;
    }
    if (candidate.type === "for_statement" && knownNonEmptyLoop(candidate, source)) continue;
    if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement", "go_statement", "defer_statement", "func_literal"].includes(candidate.type)) {
      return false;
    }
  }
  return !precededByReturn(node, callable);
}

function knownNonEmptyLoop(loop: Node, source: string): boolean {
  const body = loop.childForFieldName("body");
  if (body === null) return false;
  const header = source.slice(loop.startIndex, body.startIndex).replace(/\s+/g, " ");
  const match = header.match(/^for\s+([A-Za-z_]\w*)\s*:=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;/);
  return match !== null && Number(match[2]) > 0;
}

function directlyWithinLoop(node: Node, loop: Node): boolean {
  for (let candidate = node.parent; candidate !== null && candidate.id !== loop.id; candidate = candidate.parent) {
    if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"].includes(candidate.type)) {
      return false;
    }
    if (candidate.type === "func_literal") {
      const args = candidate.parent;
      const call = args?.type === "argument_list" ? args.parent : undefined;
      if (call?.type !== "call_expression") return false;
      node = call;
    }
  }
  return true;
}

function identifierAssignedBefore(owner: Node, name: string, before: number, source: string): boolean {
  return [
    ...descendants(owner, "assignment_statement"),
    ...descendants(owner, "short_var_declaration"),
  ].some((assignment) => {
    if (assignment.startIndex >= before || owningCallable(assignment)?.id !== owner.id) return false;
    const left = assignment.childForFieldName("left");
    return left !== null && descendants(left, "identifier").some((identifier) => sourceText(identifier, source) === name);
  });
}

function precededByReturn(node: Node, owner: Node): boolean {
  const statements = nearestStatementList(node, owner);
  if (statements === undefined) return false;
  return statements.namedChildren.some((statement) =>
    statement.endIndex <= node.startIndex && statement.type === "return_statement");
}

function nearestStatementList(node: Node, owner: Node): Node | undefined {
  for (let candidate = node.parent; candidate !== null && candidate.id !== owner.id; candidate = candidate.parent) {
    if (candidate.type === "statement_list") return candidate;
  }
  return undefined;
}

function invokedByProvenHelper(
  fn: Node,
  test: Node,
  source: string,
  callbackExecutors: Map<string, Set<number>>,
): boolean {
  const argumentsNode = fn.parent;
  const call = argumentsNode?.type === "argument_list" ? argumentsNode.parent : undefined;
  if (call?.type !== "call_expression") return false;
  const callable = call.childForFieldName("function");
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (callable?.type !== "identifier") return false;
  const helper = sourceText(callable, source);
  const argumentIndex = args.findIndex((argument) => argument.id === fn.id);
  if (argumentIndex < 0 || !callbackExecutors.get(helper)?.has(argumentIndex)) return false;
  if (locallyBindsIdentifier(test, helper, call.startIndex, source)) return false;
  return directlyWithinCallable(call, test, source);
}

function locallyBindsIdentifier(test: Node, name: string, before: number, source: string): boolean {
  return [
    ...descendants(test, "short_var_declaration"),
    ...descendants(test, "var_declaration"),
    ...descendants(test, "assignment_statement"),
  ].some((binding) => {
    if (binding.startIndex >= before || owningCallable(binding)?.id !== test.id) return false;
    const left = binding.childForFieldName("left") ?? binding;
    return descendants(left, "identifier").some((identifier) => sourceText(identifier, source) === name);
  });
}

function directInvocation(fn: Node): Node | undefined {
  let callable: Node = fn;
  while (callable.parent?.type === "parenthesized_expression") callable = callable.parent;
  const call = callable.parent;
  return call?.type === "call_expression" && call.childForFieldName("function")?.id === callable.id ? call : undefined;
}

function directlyInvokedFromTest(
  fn: Node,
  test: Node,
  source: string,
  callbackExecutors: Map<string, Set<number>>,
): boolean {
  const call = directInvocation(fn);
  if (call === undefined) return false;
  const owner = owningCallable(call);
  if (owner === undefined) return false;
  if (owner.id === test.id) return directlyWithinCallable(call, test, source);
  if (owner.type !== "func_literal" || !directlyWithinCallable(call, owner, source)) return false;
  return directlyInvokedFromTest(owner, test, source, callbackExecutors) ||
    invokedByProvenHelper(owner, test, source, callbackExecutors);
}

function selectorField(callable: Node, source: string): string | undefined {
  if (callable.type !== "selector_expression") return undefined;
  const field = callable.childForFieldName("field") ?? callable.namedChild(callable.namedChildCount - 1);
  return field === null ? undefined : sourceText(field, source);
}

function isTestOracle(callable: Node, source: string): boolean {
  if (callable.type !== "selector_expression") return false;
  const field = selectorField(callable, source);
  const operand = callable.childForFieldName("operand") ?? callable.namedChild(0);
  if (field === undefined || operand === null) return false;
  const receiver = sourceText(operand, source).replace(/\s/g, "");
  return /^(?:assert|require)(?:\.\w+)?$/.test(receiver) ||
    /^(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow|NoError|Equal|Zero|NotZero|Nil|NotNil)$/.test(field);
}

function owningCallable(node: Node): Node | undefined {
  for (let candidate = node.parent; candidate !== null; candidate = candidate.parent) {
    if (candidate.type === "function_declaration" || candidate.type === "method_declaration" || candidate.type === "func_literal") {
      return candidate;
    }
  }
  return undefined;
}

function ancestor(node: Node, type: string, boundary: Node): Node | undefined {
  for (let candidate = node.parent; candidate !== null && candidate.id !== boundary.id; candidate = candidate.parent) {
    if (candidate.type === type) return candidate;
  }
  return undefined;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function changed(file: SourceRevision, startLine: number, endLine: number): boolean {
  if (file.status === "added") return true;
  for (let line = startLine; line <= endLine; line += 1) {
    if (file.changedLines.has(line)) return true;
  }
  return false;
}

function eligibleSource(file: SourceRevision): boolean {
  if (/(?:^|\/)(?:vendor|testdata|generated|mocks?|fakes?)(?:\/|$)/i.test(file.path.replaceAll("\\", "/"))) {
    return false;
  }
  return !/^\s*\/\/ Code generated .* DO NOT EDIT\./m.test(file.current.slice(0, 2_000));
}
