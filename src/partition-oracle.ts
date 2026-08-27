import type { Node, Tree } from "web-tree-sitter";
import { descendants, sourceText } from "./parser.js";
import type { Signal, SourceRevision } from "./types.js";

type Partition = "header" | "trailer";
type AssertionState = "present" | "absent" | "unknown";

interface PartitionRead {
  partition: Partition;
  prefix: string;
  receiver: string;
  key?: string;
  line: number;
  anchors: number[];
  state: AssertionState;
}

interface PartitionGroup {
  scope: Node;
  prefix: string;
  receiver: string;
  reads: PartitionRead[];
  dynamicKey: boolean;
}

const ASSERTION_IMPORT = /^(?:([A-Za-z_]\w*)\s+)?["`]([^"`]+\/(assert|require))["`]$/;
const EQUALITY_ASSERTIONS = new Set(["Equal", "EqualValues", "Exactly"]);
const ACCESSORS = new Map<string, { prefix: string; partition: Partition }>([
  ["RequestHeader", { prefix: "Request", partition: "header" }],
  ["RequestHeaders", { prefix: "Request", partition: "header" }],
  ["RequestTrailer", { prefix: "Request", partition: "trailer" }],
  ["RequestTrailers", { prefix: "Request", partition: "trailer" }],
  ["ResponseHeader", { prefix: "Response", partition: "header" }],
  ["ResponseHeaders", { prefix: "Response", partition: "header" }],
  ["ResponseTrailer", { prefix: "Response", partition: "trailer" }],
  ["ResponseTrailers", { prefix: "Response", partition: "trailer" }],
]);

/**
 * Detect a deliberately narrow test-oracle defect: direct assertions prove
 * distinct literal metadata in both halves of a header/trailer partition, but
 * never prove that either key is absent from the opposite half. In that shape,
 * an implementation that copies or merges the two partitions still passes.
 */
export function partitionOracleSignals(file: SourceRevision, tree: Tree): Signal[] {
  if (!file.path.endsWith("_test.go")) return [];

  const testify = testifyReceivers(tree.rootNode, file.current);
  const groups = new Map<string, PartitionGroup>();
  for (const call of descendants(tree.rootNode, "call_expression")) {
    const read = partitionRead(call, file.current);
    if (read === undefined) continue;
    const scope = owningFunction(call);
    if (scope === undefined || !eligibleTestScope(scope, file.current)) continue;
    const key = `${scope.startIndex}\0${read.receiver}\0${read.prefix}`;
    const group = groups.get(key) ?? {
      scope,
      prefix: read.prefix,
      receiver: read.receiver,
      reads: [],
      dynamicKey: false,
    };
    if (read.key === undefined) group.dynamicKey = true;
    const assertion = assertionEvidence(call, scope, testify, file.current);
    group.reads.push({
      ...read,
      state: assertion.state,
      anchors: [...new Set([...read.anchors, ...assertion.anchors])],
    });
    groups.set(key, group);
  }

  const signals: Signal[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.scope.startIndex - right.scope.startIndex)) {
    if (group.dynamicKey || !receiverBindingStable(group.scope, group.receiver, file.current)) continue;
    const presentHeader = keys(group.reads, "header", "present");
    const presentTrailer = keys(group.reads, "trailer", "present");
    const absentHeader = keys(group.reads, "header", "absent");
    const absentTrailer = keys(group.reads, "trailer", "absent");
    const headerOnly = [...presentHeader].filter((key) => !presentTrailer.has(key)).sort();
    const trailerOnly = [...presentTrailer].filter((key) => !presentHeader.has(key)).sort();
    if (headerOnly.length === 0 || trailerOnly.length === 0) continue;
    const missingFromTrailers = headerOnly.filter((key) => !absentTrailer.has(key));
    const missingFromHeaders = trailerOnly.filter((key) => !absentHeader.has(key));
    if (missingFromTrailers.length === 0 && missingFromHeaders.length === 0) continue;

    const anchors = [...new Set(group.reads
      .filter((read) => read.state !== "unknown" && read.key !== undefined)
      .flatMap((read) => read.anchors))].sort((left, right) => left - right);
    const line = anchors[0];
    if (line === undefined) continue;
    const fingerprint = JSON.stringify({
      prefix: group.prefix,
      headerOnly,
      trailerOnly,
      missingFromHeaders,
      missingFromTrailers,
    });
    const boundary = group.prefix.length === 0 ? "header/trailer" : `${group.prefix.toLowerCase()} header/trailer`;
    signals.push({
      ruleId: "go-test.partition-boundary-oracle",
      path: file.path,
      line,
      locality: { kind: "direct", anchors },
      message:
        `These tests prove values in both ${boundary} partitions but omit ${missingFromTrailers.length + missingFromHeaders.length} opposite-partition absence check(s); copying or merging the partitions would still pass.`,
      snippet: (file.current.split("\n")[line - 1] ?? "").trim().slice(0, 300),
      data: {
        receiver: group.receiver,
        partition: boundary,
        headerKeys: headerOnly,
        trailerKeys: trailerOnly,
        missingFromHeaders,
        missingFromTrailers,
        fingerprint,
      },
    });
  }
  return signals;
}

function partitionRead(call: Node, source: string): Omit<PartitionRead, "state"> | undefined {
  const fn = call.childForFieldName("function");
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn?.type !== "selector_expression" || args.length !== 1) return undefined;
  const method = fn.childForFieldName("field");
  const accessorCall = transparent(fn.childForFieldName("operand"));
  if (method === null || sourceText(method, source) !== "Get" || accessorCall?.type !== "call_expression") {
    return undefined;
  }
  if ((accessorCall.childForFieldName("arguments")?.namedChildren.length ?? -1) !== 0) return undefined;
  const accessorSelector = accessorCall.childForFieldName("function");
  if (accessorSelector?.type !== "selector_expression") return undefined;
  const receiverNode = transparent(accessorSelector.childForFieldName("operand"));
  const accessorNode = accessorSelector.childForFieldName("field");
  if (receiverNode?.type !== "identifier" || accessorNode === null) return undefined;
  const accessor = ACCESSORS.get(sourceText(accessorNode, source));
  if (accessor === undefined) return undefined;
  const key = stringValue(transparent(args[0]), source)?.toLowerCase();
  return {
    ...accessor,
    receiver: sourceText(receiverNode, source),
    ...(key === undefined ? {} : { key }),
    line: call.startPosition.row + 1,
    anchors: [
      call.startPosition.row + 1,
      accessorCall.startPosition.row + 1,
      args[0]!.startPosition.row + 1,
    ],
  };
}

function assertionEvidence(
  read: Node,
  scope: Node,
  testify: Set<string>,
  source: string,
): { state: AssertionState; anchors: number[] } {
  const assigned = immediatelyAssertedAssignment(read, scope, testify, source);
  if (assigned !== undefined) return assigned;
  let current = read.parent;
  while (current !== null && contains(scope, current)) {
    if (current.type === "call_expression") {
      const evidence = testifyAssertionEvidence(current, read, scope, testify, source);
      if (evidence !== undefined) return evidence;
    }
    if (current.type === "binary_expression") {
      const evidence = failingComparisonEvidence(current, read, source);
      if (evidence !== undefined) return evidence;
    }
    if (["expression_statement", "short_var_declaration", "assignment_statement"].includes(current.type)) break;
    current = current.parent;
  }
  return { state: "unknown", anchors: [] };
}

function testifyAssertionEvidence(
  assertion: Node,
  read: Node,
  scope: Node,
  testify: Set<string>,
  source: string,
): { state: AssertionState; anchors: number[] } | undefined {
  if (directStatement(scope, assertion) === undefined) return undefined;
  const fn = assertion.childForFieldName("function");
  const args = assertion.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn?.type !== "selector_expression") return undefined;
  const receiver = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (receiver?.type !== "identifier" || field === null || !testify.has(sourceText(receiver, source))) {
    return undefined;
  }
  if (locallyDeclaredAt(scope, sourceText(receiver, source), assertion, source)) return undefined;
  const method = sourceText(field, source);
  if (EQUALITY_ASSERTIONS.has(method)) {
    if (args.length !== 3) return undefined;
    const values = args.slice(1);
    const actualIndex = values.findIndex((candidate) => sameExpression(candidate, read));
    if (actualIndex < 0 || values.filter((candidate) => sameExpression(candidate, read)).length !== 1) return undefined;
    const expected = values[1 - actualIndex];
    if (expected === undefined) return undefined;
    return {
      state: literalState(expected, source),
      anchors: [assertion.startPosition.row + 1, expected.startPosition.row + 1, read.startPosition.row + 1],
    };
  }
  if ((method === "Empty" || method === "NotEmpty") && args.length === 2 && sameExpression(args[1]!, read)) {
    return {
      state: method === "Empty" ? "absent" : "present",
      anchors: [assertion.startPosition.row + 1, args[1]!.startPosition.row + 1],
    };
  }
  return undefined;
}

function immediatelyAssertedAssignment(
  read: Node,
  scope: Node,
  assertionReceivers: Set<string>,
  source: string,
): { state: AssertionState; anchors: number[] } | undefined {
  const declaration = ancestor(read, "short_var_declaration");
  if (declaration === undefined || directStatement(scope, declaration) === undefined) return undefined;
  const left = declaration.childForFieldName("left");
  const right = declaration.childForFieldName("right");
  if (left === null || right === null) return undefined;
  const rightValues = right.type === "expression_list" ? right.namedChildren : [right];
  const callIndex = rightValues.findIndex((candidate) => sameExpression(candidate, read));
  const leftValues = left.type === "expression_list" ? left.namedChildren : [left];
  const variable = leftValues[callIndex];
  if (callIndex < 0 || variable?.type !== "identifier") return undefined;

  const statements = declaration.parent;
  if (statements?.type !== "statement_list") return undefined;
  const index = statements.namedChildren.findIndex((candidate) =>
    candidate.startIndex === declaration.startIndex && candidate.endIndex === declaration.endIndex
  );
  const next = statements.namedChildren[index + 1];
  if (index < 0 || next?.type !== "expression_statement" || directStatement(scope, next) === undefined) return undefined;
  const calls = descendants(next, "call_expression").filter((call) => importedAssertionCall(call, scope, assertionReceivers, source));
  if (calls.length !== 1) return undefined;
  const assertion = calls[0]!;
  const fn = assertion.childForFieldName("function");
  const field = fn?.type === "selector_expression" ? fn.childForFieldName("field") : null;
  const args = assertion.childForFieldName("arguments")?.namedChildren ?? [];
  if (field === null || field === undefined) return undefined;
  const method = sourceText(field, source);
  const name = sourceText(variable, source);

  if (EQUALITY_ASSERTIONS.has(method)) {
    if (args.length !== 3) return undefined;
    const values = args.slice(1);
    const actualIndex = values.findIndex((candidate) => candidate.type === "identifier" && sourceText(candidate, source) === name);
    if (
      actualIndex < 0 || values.filter((candidate) =>
        candidate.type === "identifier" && sourceText(candidate, source) === name
      ).length !== 1
    ) return undefined;
    const expected = values[1 - actualIndex];
    if (expected === undefined) return undefined;
    return {
      state: literalState(expected, source),
      anchors: [
        declaration.startPosition.row + 1,
        read.startPosition.row + 1,
        assertion.startPosition.row + 1,
        variable.startPosition.row + 1,
        expected.startPosition.row + 1,
      ],
    };
  }
  if ((method === "Empty" || method === "NotEmpty") && args.length === 2) {
    const actual = args[1]!;
    if (actual.type !== "identifier" || sourceText(actual, source) !== name) return undefined;
    return {
      state: method === "Empty" ? "absent" : "present",
      anchors: [declaration.startPosition.row + 1, read.startPosition.row + 1, assertion.startPosition.row + 1],
    };
  }
  return undefined;
}

function importedAssertionCall(call: Node, scope: Node, receivers: Set<string>, source: string): boolean {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return false;
  const receiver = fn.childForFieldName("operand");
  return receiver?.type === "identifier" && receivers.has(sourceText(receiver, source)) &&
    !locallyDeclaredAt(scope, sourceText(receiver, source), call, source);
}

function failingComparisonEvidence(
  comparison: Node,
  read: Node,
  source: string,
): { state: AssertionState; anchors: number[] } | undefined {
  const conditional = ancestor(comparison, "if_statement");
  const scope = owningFunction(comparison);
  const condition = conditional?.childForFieldName("condition");
  const consequence = conditional?.childForFieldName("consequence");
  if (
    conditional === undefined || scope === undefined || directStatement(scope, conditional) === undefined ||
    condition === null || condition === undefined ||
    consequence === null || consequence === undefined || !contains(condition, comparison) ||
    !hasTestingFailure(consequence, comparison, source)
  ) return undefined;
  const left = transparent(comparison.childForFieldName("left"));
  const right = transparent(comparison.childForFieldName("right"));
  if (left === undefined || right === undefined) return undefined;
  const actualOnLeft = sameExpression(left, read);
  const actualOnRight = sameExpression(right, read);
  if (!actualOnLeft && !actualOnRight) return undefined;
  const expected = actualOnLeft ? right : left;
  const operator = source.slice(left.endIndex, right.startIndex).trim();
  const value = stringValue(expected, source);
  if (value === undefined) return undefined;
  if (operator === "!=") {
    return {
      state: value.length === 0 ? "absent" : "present",
      anchors: [comparison.startPosition.row + 1, expected.startPosition.row + 1, read.startPosition.row + 1],
    };
  }
  if (operator === "==" && value.length === 0) {
    return {
      state: "present",
      anchors: [comparison.startPosition.row + 1, expected.startPosition.row + 1, read.startPosition.row + 1],
    };
  }
  return undefined;
}

function directStatement(scope: Node, node: Node): Node | undefined {
  const statement = topLevelStatement(scope, node);
  if (statement === undefined) return undefined;
  const statements = statement.parent;
  if (statements === null) return undefined;
  const index = statements.namedChildren.findIndex((candidate) =>
    candidate.startIndex === statement.startIndex && candidate.endIndex === statement.endIndex
  );
  if (index < 0) return undefined;
  if (statements.namedChildren.slice(0, index).some((candidate) => definitelyTerminates(candidate))) {
    return undefined;
  }
  return statement;
}

function topLevelStatement(scope: Node, node: Node): Node | undefined {
  let statement: Node | undefined;
  let current: Node | null = node;
  while (current !== null && current.startIndex >= scope.startIndex) {
    if (current.parent?.type === "statement_list") {
      statement = current;
      break;
    }
    current = current.parent;
  }
  const body = scope.childForFieldName("body");
  const statements = statement?.parent;
  if (statement === undefined || statements === null || statements === undefined || statements.parent?.startIndex !== body?.startIndex) {
    return undefined;
  }
  return statement;
}

function definitelyTerminates(statement: Node): boolean {
  if (statement.type === "return_statement" || statement.type === "goto_statement") return true;
  if (statement.type !== "if_statement") return false;
  const consequence = statement.childForFieldName("consequence");
  const alternative = statement.childForFieldName("alternative");
  if (consequence === null || alternative === null) return false;
  return blockTerminates(consequence) &&
    (alternative.type === "if_statement" ? definitelyTerminates(alternative) : blockTerminates(alternative));
}

function blockTerminates(block: Node): boolean {
  const statements = block.type === "block" ? block.namedChildren : [block];
  return statements.some((statement) => definitelyTerminates(statement));
}

function literalState(node: Node, source: string): AssertionState {
  const value = transparent(node);
  if (value === undefined) return "unknown";
  if (value.type === "nil") return "absent";
  const string = stringValue(value, source);
  return string === undefined ? "unknown" : string.length === 0 ? "absent" : "present";
}

function receiverBindingStable(scope: Node, name: string, source: string): boolean {
  let declarations = 0;
  const parameters = scope.childForFieldName("parameters");
  if (parameters !== null && parameters !== undefined) {
    declarations += descendants(parameters, "identifier").filter((node) => sourceText(node, source) === name).length;
  }
  for (const declaration of descendants(scope, "short_var_declaration")) {
    if (owningFunction(declaration)?.startIndex !== scope.startIndex) continue;
    const statement = topLevelStatement(scope, declaration);
    if (statement?.startIndex !== declaration.startIndex || statement.endIndex !== declaration.endIndex) continue;
    const left = declaration.childForFieldName("left");
    if (left !== null && identifierList(left, source).includes(name)) declarations += 1;
  }
  for (const specification of descendants(scope, "var_spec")) {
    if (owningFunction(specification)?.startIndex !== scope.startIndex) continue;
    const declaration = ancestor(specification, "var_declaration");
    const statement = declaration === undefined ? undefined : topLevelStatement(scope, declaration);
    if (
      declaration === undefined || statement?.startIndex !== declaration.startIndex ||
      statement.endIndex !== declaration.endIndex
    ) continue;
    const names = specification.childForFieldName("name");
    if (names !== null && identifierList(names, source).includes(name)) declarations += 1;
  }
  if (declarations !== 1) return false;
  for (const assignment of descendants(scope, "assignment_statement")) {
    if (owningFunction(assignment)?.startIndex !== scope.startIndex) continue;
    const left = assignment.childForFieldName("left");
    if (left !== null && identifierList(left, source).includes(name)) return false;
  }
  return true;
}

function locallyDeclaredAt(scope: Node, name: string, use: Node, source: string): boolean {
  const parameters = scope.childForFieldName("parameters");
  if (
    parameters !== null && parameters !== undefined &&
    descendants(parameters, "identifier").some((node) => sourceText(node, source) === name)
  ) {
    return true;
  }
  const statement = topLevelStatement(scope, use);
  const statements = statement?.parent;
  if (statement === undefined || statements === null || statements === undefined) return true;
  const index = statements.namedChildren.findIndex((candidate) =>
    candidate.startIndex === statement.startIndex && candidate.endIndex === statement.endIndex
  );
  if (index < 0) return true;
  for (const candidate of statements.namedChildren.slice(0, index)) {
    if (candidate.type === "short_var_declaration") {
      const left = candidate.childForFieldName("left");
      if (left !== null && identifierList(left, source).includes(name)) return true;
    }
    if (candidate.type === "var_declaration") {
      for (const specification of descendants(candidate, "var_spec")) {
        const names = specification.childForFieldName("name");
        if (names !== null && identifierList(names, source).includes(name)) return true;
      }
    }
  }
  return false;
}

function identifierList(node: Node, source: string): string[] {
  if (node.type === "identifier") return [sourceText(node, source)];
  return node.namedChildren.filter((child) => child.type === "identifier").map((child) => sourceText(child, source));
}

function keys(reads: PartitionRead[], partition: Partition, state: AssertionState): Set<string> {
  return new Set(reads.flatMap((read) =>
    read.partition === partition && read.state === state && read.key !== undefined ? [read.key] : []
  ));
}

function testifyReceivers(root: Node, source: string): Set<string> {
  const receivers = new Set<string>();
  for (const spec of descendants(root, "import_spec")) {
    const match = sourceText(spec, source).trim().match(ASSERTION_IMPORT);
    if (match === null) continue;
    const receiver = match[1] ?? match[3];
    if (receiver !== undefined && receiver !== "_" && receiver !== ".") receivers.add(receiver);
  }
  return receivers;
}

function hasTestingFailure(branch: Node, context: Node, source: string): boolean {
  const testVariables = testingVariables(context, source);
  if (testVariables.size === 0) return false;
  const methods = new Set(["Fatal", "Fatalf", "Error", "Errorf", "Fail", "FailNow"]);
  return descendants(branch, "call_expression").some((call) => {
    if (owningFunction(call)?.startIndex !== owningFunction(context)?.startIndex) return false;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    return operand?.type === "identifier" && field !== null &&
      testVariables.has(sourceText(operand, source)) && methods.has(sourceText(field, source));
  });
}

function testingVariables(node: Node, source: string): Set<string> {
  const scope = owningFunction(node);
  if (scope === undefined) return new Set();
  const parameters = scope?.childForFieldName("parameters");
  if (parameters === null || parameters === undefined) return new Set();
  const names = new Set<string>();
  const pattern = /([A-Za-z_]\w*)\s+\*testing\.(?:T|B)\b/g;
  for (const match of sourceText(parameters, source).matchAll(pattern)) {
    if (match[1] !== undefined && !locallyDeclaredOutsideParameters(scope, match[1], source)) names.add(match[1]);
  }
  return names;
}

function locallyDeclaredOutsideParameters(scope: Node, name: string, source: string): boolean {
  for (const declaration of descendants(scope, "short_var_declaration")) {
    const left = declaration.childForFieldName("left");
    if (left !== null && identifierList(left, source).includes(name)) return true;
  }
  for (const specification of descendants(scope, "var_spec")) {
    const names = specification.childForFieldName("name");
    if (names !== null && identifierList(names, source).includes(name)) return true;
  }
  return false;
}

function stringValue(node: Node | undefined, source: string): string | undefined {
  const value = transparent(node);
  if (value === undefined) return undefined;
  const text = sourceText(value, source);
  if (value.type === "raw_string_literal") return text.slice(1, -1);
  if (value.type !== "interpreted_string_literal") return undefined;
  try {
    return JSON.parse(text) as string;
  } catch {
    return undefined;
  }
}

function transparent(node: Node | null | undefined): Node | undefined {
  let current = node ?? undefined;
  while (current !== undefined && current.type === "parenthesized_expression" && current.namedChildCount === 1) {
    current = current.namedChild(0) ?? undefined;
  }
  return current;
}

function sameExpression(node: Node, target: Node): boolean {
  const value = transparent(node);
  return value?.startIndex === target.startIndex && value.endIndex === target.endIndex;
}

function owningFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "function_declaration" || current.type === "func_literal") return current;
    current = current.parent;
  }
  return undefined;
}

function eligibleTestScope(scope: Node, source: string): boolean {
  if (scope.type === "function_declaration") {
    const name = scope.childForFieldName("name");
    return name !== null && /^(?:Test|Benchmark)[A-Z0-9_]/.test(sourceText(name, source));
  }
  if (scope.type !== "func_literal") return false;
  const argumentsNode = scope.parent;
  const call = argumentsNode?.type === "argument_list" ? argumentsNode.parent : undefined;
  if (call?.type !== "call_expression") return false;
  const fn = call.childForFieldName("function");
  const field = fn?.type === "selector_expression" ? fn.childForFieldName("field") : null;
  const receiver = fn?.type === "selector_expression" ? fn.childForFieldName("operand") : null;
  if (
    field === null || field === undefined || sourceText(field, source) !== "Run" || receiver?.type !== "identifier"
  ) return false;
  return testingVariables(call, source).has(sourceText(receiver, source));
}

function ancestor(node: Node, type: string): Node | undefined {
  let current = node.parent;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return undefined;
}

function contains(parent: Node, child: Node): boolean {
  return parent.startIndex <= child.startIndex && parent.endIndex >= child.endIndex;
}
