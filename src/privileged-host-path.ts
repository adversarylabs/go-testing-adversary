import { basename, posix } from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import { sourceText, walk } from "./parser.js";
import type { Signal, SourceRevision } from "./types.js";

interface PathProof {
  root: string;
  anchors: number[];
  expression: string;
}

interface PathCandidate {
  node: Node;
  literal?: string;
}

const privilegedRoots = ["/etc", "/usr", "/bin", "/sbin", "/var/lib"];
const osTargetArguments = new Map<string, number[]>([
  ["Chmod", [0]], ["Chown", [0]], ["Chtimes", [0]], ["Create", [0]], ["CreateTemp", [0]],
  ["Lchown", [0]], ["Link", [1]], ["Mkdir", [0]], ["MkdirAll", [0]],
  ["MkdirTemp", [0]], ["Remove", [0]], ["RemoveAll", [0]], ["Rename", [0, 1]],
  ["Symlink", [1]], ["Truncate", [0]], ["WriteFile", [0]],
]);
const mutatingCommands = new Set([
  "chmod", "chown", "chgrp", "cp", "install", "ln", "mkdir", "mv", "rm", "rmdir", "tee", "touch", "truncate",
]);

export function privilegedHostPathSignals(file: SourceRevision, tree: Tree): Signal[] {
  if (!file.path.endsWith("_test.go")) return [];
  const aliases = importAliases(tree.rootNode, file.current);
  const osAlias = aliases.get("os");
  const execAlias = aliases.get("os/exec");
  const joinAliases = new Set([aliases.get("path"), aliases.get("path/filepath")].filter((item): item is string => item !== undefined));
  const signals: Signal[] = [];

  walk(tree.rootNode, (node) => {
    if (node.type !== "call_expression") return;
    if (insideUnprovenFunctionLiteral(node)) return;
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    if (fn === null) return;
    const directFunction = unwrapParentheses(fn);
    const functionName = sourceText(directFunction, file.current);
    let operation: string | undefined;
    let candidates: PathCandidate[] = [];
    let executionAnchors: number[] = [];

    if (
      osAlias !== undefined &&
      !identifierShadowed(osAlias, node, file.current) &&
      functionName.startsWith(`${osAlias}.`)
    ) {
      operation = functionName.slice(osAlias.length + 1);
      const positions = osTargetArguments.get(operation);
      if (positions === undefined) {
        if (operation !== "OpenFile" || !directOpenFileMutates(args[1], file.current, osAlias)) return;
        candidates = args[0] === undefined ? [] : [{ node: args[0] }];
      } else {
        candidates = positions.flatMap((position) => args[position] === undefined ? [] : [{ node: args[position]! }]);
      }
    } else if (
      execAlias !== undefined &&
      !identifierShadowed(execAlias, node, file.current) &&
      (functionName === `${execAlias}.Command` || functionName === `${execAlias}.CommandContext`)
    ) {
      const offset = functionName.endsWith("CommandContext") ? 1 : 0;
      const command = stringLiteral(args[offset], file.current);
      const executedAt = command === undefined || !trustedCommand(command)
        ? undefined
        : commandExecutionAnchors(node, file.current);
      if (command === undefined || executedAt === undefined) return;
      operation = `exec ${basename(command)}`;
      candidates = commandTargets(basename(command), args.slice(offset + 1), file.current);
      executionAnchors = executedAt;
    } else {
      return;
    }

    for (const candidate of candidates) {
      const proof = candidate.literal === undefined
        ? resolvePrivilegedPath(candidate.node, node, file.current, joinAliases, new Set())
        : literalProof(candidate.literal, candidate.node);
      if (proof === undefined) continue;
      const callLine = node.startPosition.row + 1;
      const pathLine = candidate.node.startPosition.row + 1;
      const commandLine = args[functionName.endsWith("CommandContext") ? 1 : 0]?.startPosition.row;
      const anchors = [...new Set([
        callLine,
        ...nodeLines(candidate.node),
        ...executionAnchors,
        ...(commandLine === undefined ? [] : [commandLine + 1]),
        ...proof.anchors,
      ])].sort((left, right) => left - right);
      const scope = enclosingFunctionName(node, file.current);
      signals.push({
        ruleId: "go-test.privileged-host-path-mutation",
        path: file.path,
        line: callLine,
        locality: { kind: "direct", anchors },
        message: `Test ${operation} mutates the host's ${proof.root} tree instead of test-owned storage.`,
        snippet: sourceText(node, file.current).trim().slice(0, 300),
        data: {
          operation,
          privilegedRoot: proof.root,
          pathExpression: proof.expression,
          callLine,
          pathLine,
          fingerprint: `${scope}\u0000${operation}\u0000${proof.expression}\u0000${normalize(sourceText(node, file.current))}`,
        },
      });
      break;
    }
  });

  return signals;
}

function insideUnprovenFunctionLiteral(node: Node): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type !== "func_literal") continue;
    let invoked: Node = current;
    while (invoked.parent?.type === "parenthesized_expression") invoked = invoked.parent;
    const call = invoked.parent;
    if (call?.type !== "call_expression" || call.childForFieldName("function")?.id !== invoked.id) return true;
  }
  return false;
}

function importAliases(root: Node, source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  walk(root, (node) => {
    if (node.type !== "import_spec") return;
    const pathNode = node.childForFieldName("path") ?? node.namedChildren.at(-1) ?? null;
    if (pathNode === null) return;
    const path = stringLiteral(pathNode, source);
    if (path === undefined) return;
    const nameNode = node.childForFieldName("name");
    const alias = nameNode === null ? basename(path) : sourceText(nameNode, source);
    if (alias !== "." && alias !== "_") aliases.set(path, alias);
  });
  return aliases;
}

function resolvePrivilegedPath(
  expression: Node,
  use: Node,
  source: string,
  joinAliases: Set<string>,
  seen: Set<string>,
): PathProof | undefined {
  const literal = stringLiteral(expression, source);
  if (literal !== undefined) return literalProof(literal, expression);

  if (expression.type === "identifier") {
    const name = sourceText(expression, source);
    const key = `${name}:${expression.startIndex}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const binding = visibleBinding(name, use, source);
    if (binding === undefined) return undefined;
    if (hasConditionalAssignment(name, use, binding, source) || hasNestedFunctionAssignment(name, use, binding, source)) return undefined;
    const proof = resolvePrivilegedPath(binding, binding, source, joinAliases, new Set(seen));
    return proof === undefined ? undefined : { ...proof, anchors: [...proof.anchors, ...nodeLines(binding)] };
  }

  if (expression.type === "binary_expression") {
    const left = expression.childForFieldName("left");
    const right = expression.childForFieldName("right");
    const operator = expression.childForFieldName("operator");
    if (left !== null && right !== null && operator !== null && sourceText(operator, source) === "+") {
      const prefix = resolvePrivilegedPath(left, use, source, joinAliases, seen);
      const suffix = stringLiteral(right, source);
      if (prefix === undefined || suffix === undefined) return undefined;
      return literalProof(`${prefix.expression}${suffix}`, expression);
    }
  }

  if (expression.type === "call_expression") {
    const fn = expression.childForFieldName("function");
    const args = expression.childForFieldName("arguments")?.namedChildren ?? [];
    if (fn !== null) {
      const name = sourceText(fn, source);
      const joinAlias = [...joinAliases].find((alias) => name === `${alias}.Join`);
      if (joinAlias !== undefined && !identifierShadowed(joinAlias, expression, source) && args.length > 0) {
        const first = resolvePrivilegedPath(args[0]!, use, source, joinAliases, seen);
        if (first === undefined) return undefined;
        const suffixes = args.slice(1).map((argument) => stringLiteral(argument, source));
        if (suffixes.some((part) => part === undefined)) return undefined;
        return literalProof(posix.join(first.expression, ...suffixes as string[]), expression);
      }
    }
  }
  return undefined;
}

function visibleBinding(name: string, use: Node, source: string): Node | undefined {
  let child: Node = use;
  for (let scope = use.parent; scope !== null; child = scope, scope = scope.parent) {
    if (scope.type === "statement_list" || scope.type === "source_file") {
      let result: Node | undefined;
      for (const statement of scope.namedChildren) {
        if (statement.startIndex >= child.startIndex) break;
        const binding = directBinding(statement, name, source);
        if (binding !== undefined) result = binding;
      }
      if (result !== undefined) return result;
    }
    const clause = controlClauseBinding(scope, name, source);
    if (clause !== undefined) return clause;
  }
  return undefined;
}

function directBinding(statement: Node, name: string, source: string): Node | undefined {
  if (statement.type === "short_var_declaration" || statement.type === "assignment_statement" || statement.type === "receive_statement") {
    const left = fieldExpressions(statement.childForFieldName("left"));
    const right = fieldExpressions(statement.childForFieldName("right"));
    const index = left.findIndex((item) => item.type === "identifier" && sourceText(item, source) === name);
    return index < 0 ? undefined : right[index];
  }
  if (statement.type === "var_declaration" || statement.type === "const_declaration") {
    for (const spec of statement.namedChildren) {
      if (spec.type !== "var_spec" && spec.type !== "const_spec") continue;
      const nameNode = spec.childForFieldName("name");
      const names = nameNode === null
        ? spec.namedChildren.filter((item) => item.type === "identifier")
        : nameNode.type === "identifier" ? [nameNode] : nameNode.namedChildren;
      const values = fieldExpressions(spec.childForFieldName("value"));
      const index = names.findIndex((item) => sourceText(item, source) === name);
      if (index >= 0) return values[index];
    }
  }
  return undefined;
}

function literalProof(value: string, node: Node): PathProof | undefined {
  const normalized = posix.normalize(value);
  const root = privilegedRoots.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  return root === undefined ? undefined : { root, anchors: nodeLines(node), expression: normalized };
}

function commandTargets(command: string, args: Node[], source: string): PathCandidate[] {
  const operands: Node[] = [];
  let targetDirectory: PathCandidate | undefined;
  let installDirectoryMode = false;
  let parsingOptions = true;
  const referenceOption = ["chmod", "chown", "touch", "truncate"].includes(command);
  for (let index = 0; index < args.length; index += 1) {
    const node = args[index]!;
    const literal = stringLiteral(node, source);
    if (parsingOptions && literal === "--") {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions || literal === undefined || !literal.startsWith("-") || literal === "-") {
      operands.push(node);
      continue;
    }

    if (referenceOption && (literal === "--reference" || (["touch", "truncate"].includes(command) && literal === "-r"))) {
      index += 1;
      continue;
    }
    if (referenceOption && literal.startsWith("--reference=")) continue;
    if (["touch", "truncate"].includes(command) && /^-[^-]*r/.test(literal)) {
      const reference = literal.indexOf("r");
      if (reference === literal.length - 1) index += 1;
      continue;
    }

    if (!["cp", "install", "ln"].includes(command)) continue;
    if (literal === "-S" || literal === "--suffix") {
      index += 1;
      continue;
    }
    if (literal.startsWith("--suffix=")) continue;
    if (literal === "-t" || literal === "--target-directory") {
      const target = args[index + 1];
      if (target !== undefined) targetDirectory = { node: target };
      index += 1;
      continue;
    }
    if (literal.startsWith("--target-directory=")) {
      targetDirectory = { node, literal: literal.slice("--target-directory=".length) };
      continue;
    }
    if (command === "install" && (literal === "-d" || literal === "--directory")) {
      installDirectoryMode = true;
      continue;
    }

    const short = literal.match(/^-(?!-)(.+)$/)?.[1];
    if (short === undefined) continue;
    for (let position = 0; position < short.length; position += 1) {
      const option = short[position]!;
      if (option === "S") {
        if (position === short.length - 1) index += 1;
        break;
      }
      if (option === "t") {
        const attached = short.slice(position + 1);
        if (attached.length > 0) targetDirectory = { node, literal: attached };
        else {
          const target = args[index + 1];
          if (target !== undefined) targetDirectory = { node: target };
          index += 1;
        }
        break;
      }
      if (command === "install" && option === "d") installDirectoryMode = true;
    }
  }

  if (["cp", "install", "ln"].includes(command)) {
    if (targetDirectory !== undefined) return [targetDirectory];
    if (command === "install" && installDirectoryMode) return operands.map((node) => ({ node }));
    return operands.at(-1) === undefined ? [] : [{ node: operands.at(-1)! }];
  }
  return operands.map((node) => ({ node }));
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildren[0] !== undefined) current = current.namedChildren[0]!;
  return current;
}

function commandExecutionAnchors(command: Node, source: string): number[] | undefined {
  const executionMethods = new Set(["CombinedOutput", "Output", "Run", "Start"]);
  let operand: Node = command;
  while (operand.parent?.type === "parenthesized_expression") operand = operand.parent;
  const selectorNode = operand.parent;
  const selector = selectorNode?.parent;
  if (
    selectorNode?.type === "selector_expression" &&
    selector?.type === "call_expression" &&
    executionMethods.has(sourceText(selectorNode.childForFieldName("field") ?? selectorNode, source).split(".").at(-1) ?? "")
  ) {
    const field = selectorNode.childForFieldName("field");
    return field === null ? [selector.startPosition.row + 1] : nodeLines(field);
  }

  return undefined;
}

function identifierShadowed(name: string, use: Node, source: string): boolean {
  for (let current = use.parent; current !== null; current = current.parent) {
    if (current.type === "function_declaration" || current.type === "method_declaration" || current.type === "func_literal") {
      for (const field of ["receiver", "parameters", "result"]) {
        const declaration = current.childForFieldName(field);
        if (declaration !== null && declaredNames(declaration, source).has(name)) return true;
      }
    }
  }
  return visibleBinding(name, use, source) !== undefined;
}

function trustedCommand(command: string): boolean {
  const name = basename(command);
  return mutatingCommands.has(name) && (command === name || command === `/bin/${name}` || command === `/usr/bin/${name}`);
}

function declaredNames(node: Node, source: string): Set<string> {
  const result = new Set<string>();
  walk(node, (candidate) => {
    if (candidate.type !== "parameter_declaration" && candidate.type !== "variadic_parameter_declaration") return;
    const name = candidate.childForFieldName("name");
    if (name === null) return;
    if (name.type === "identifier") result.add(sourceText(name, source));
    for (const child of name.namedChildren) if (child.type === "identifier") result.add(sourceText(child, source));
  });
  return result;
}

function hasConditionalAssignment(name: string, use: Node, baseline: Node, source: string): boolean {
  let found = false;
  let child: Node = use;
  for (let scope = use.parent; scope !== null; child = scope, scope = scope.parent) {
    if (scope.type !== "statement_list") continue;
    for (const statement of scope.namedChildren) {
      if (statement.startIndex >= child.startIndex) break;
      if (!["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"].includes(statement.type)) continue;
      walkExecutable(statement, (candidate) => {
        if (candidate.type !== "assignment_statement") return;
        const operator = candidate.childForFieldName("operator");
        if (operator !== null && sourceText(operator, source) !== "=") return;
        const left = candidate.childForFieldName("left")?.namedChildren ?? [];
        const right = candidate.childForFieldName("right")?.namedChildren ?? [];
        const index = left.findIndex((item) => item.type === "identifier" && sourceText(item, source) === name);
        if (index < 0 || right[index] === undefined) return;
        if (visibleBinding(name, candidate, source)?.id === baseline.id) found = true;
      });
    }
  }
  return found;
}

function hasNestedFunctionAssignment(name: string, use: Node, binding: Node, source: string): boolean {
  let callable: Node | null = use;
  while (callable !== null && !["function_declaration", "method_declaration", "func_literal"].includes(callable.type)) {
    callable = callable.parent;
  }
  if (callable === null) return false;
  let found = false;
  walk(callable, (candidate) => {
    if (candidate.startIndex <= binding.endIndex || candidate.startIndex >= use.startIndex) return;
    if (candidate.type !== "assignment_statement") return;
    const left = fieldExpressions(candidate.childForFieldName("left"));
    if (!left.some((item) => item.type === "identifier" && sourceText(item, source) === name)) return;
    for (let current = candidate.parent; current !== null && current.id !== callable!.id; current = current.parent) {
      if (current.type === "func_literal") found = true;
    }
  });
  return found;
}

function walkExecutable(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child.type === "func_literal") {
      const parent = child.parent;
      if (parent?.type !== "call_expression" || parent.childForFieldName("function")?.id !== child.id) continue;
    }
    walkExecutable(child, visit);
  }
}

function nodeLines(node: Node): number[] {
  const lines: number[] = [];
  for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line += 1) lines.push(line);
  return lines;
}

function controlClauseBinding(scope: Node, name: string, source: string): Node | undefined {
  if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement"].includes(scope.type)) {
    const initializer = scope.childForFieldName("initializer");
    const binding = initializer === null ? undefined : directBinding(initializer, name, source);
    if (binding !== undefined) return binding;
  }
  if (scope.type === "for_statement") {
    const range = scope.namedChildren.find((item) => item.type === "range_clause");
    if (range !== undefined) {
      const left = fieldExpressions(range.childForFieldName("left"));
      const index = left.findIndex((item) => item.type === "identifier" && sourceText(item, source) === name);
      if (index >= 0) return range.childForFieldName("right") ?? range;
    }
  }
  if (scope.type === "type_switch_statement") {
    const names = scope.namedChildren[0];
    const match = names?.namedChildren.find((item) => item.type === "identifier" && sourceText(item, source) === name);
    if (match !== undefined) return scope;
  }
  if (scope.type === "communication_case") {
    const receive = scope.namedChildren.find((item) => item.type === "receive_statement");
    if (receive !== undefined) {
      const binding = directBinding(receive, name, source);
      if (binding !== undefined) return binding;
    }
  }
  return undefined;
}

function fieldExpressions(node: Node | null): Node[] {
  if (node === null) return [];
  return node.type === "expression_list" || node.type === "identifier_list" ? node.namedChildren : [node];
}

function stringLiteral(node: Node | undefined, source: string): string | undefined {
  if (node === undefined || (node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal")) return undefined;
  const raw = sourceText(node, source);
  if (raw.startsWith("`")) return raw.slice(1, -1);
  try {
    return JSON.parse(raw) as string;
  } catch {
    return undefined;
  }
}

function directOpenFileMutates(flags: Node | undefined, source: string, osAlias: string): boolean {
  if (flags === undefined) return false;
  const proven = directOpenFlagSet(flags, source, osAlias);
  return proven !== undefined && ["O_WRONLY", "O_RDWR", "O_APPEND", "O_CREATE", "O_TRUNC"].some((flag) => proven.has(flag));
}

function directOpenFlagSet(node: Node, source: string, osAlias: string): Set<string> | undefined {
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner === undefined ? undefined : directOpenFlagSet(inner, source, osAlias);
  }
  if (node.type === "selector_expression") {
    const operand = node.childForFieldName("operand");
    const field = node.childForFieldName("field");
    if (operand?.type !== "identifier" || field === null || sourceText(operand, source) !== osAlias) return undefined;
    const flag = sourceText(field, source);
    const known = new Set(["O_RDONLY", "O_WRONLY", "O_RDWR", "O_APPEND", "O_CREATE", "O_EXCL", "O_SYNC", "O_TRUNC"]);
    return known.has(flag) ? new Set(flag === "O_RDONLY" ? [] : [flag]) : undefined;
  }
  if (node.type === "binary_expression") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const operator = node.childForFieldName("operator");
    if (left === null || right === null || operator === null) return undefined;
    const leftSet = directOpenFlagSet(left, source, osAlias);
    const rightSet = directOpenFlagSet(right, source, osAlias);
    if (leftSet === undefined || rightSet === undefined) return undefined;
    const op = sourceText(operator, source);
    if (op === "|") return new Set([...leftSet, ...rightSet]);
    if (op === "&^") return new Set([...leftSet].filter((flag) => !rightSet.has(flag)));
    if (op === "&") return new Set([...leftSet].filter((flag) => rightSet.has(flag)));
  }
  return undefined;
}

function enclosingFunctionName(node: Node, source: string): string {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type === "function_declaration" || current.type === "method_declaration") {
      const name = current.childForFieldName("name");
      return name === null ? "<function>" : sourceText(name, source);
    }
  }
  return "<literal>";
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
