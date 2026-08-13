import { dirname } from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import { descendants, sourceText } from "./parser.js";
import type { Signal, SourceRevision } from "./types.js";

interface SelectorCase {
  expected: string;
  first: string;
  last: string;
  line: number;
  anchors: number[];
}

export interface SelectorOracleEvidence {
  key: string;
  name: string;
  path: string;
  source: string;
  status: SourceRevision["status"];
  changedLines: Set<number>;
  calls: number[];
  cases: SelectorCase[];
  unproven: boolean;
}

const ASSERTION_NAMES = new Set(["Equal", "EqualValues", "Exactly"]);
const TESTIFY_IMPORT = /^(?:([A-Za-z_]\w*)\s+)?["`]github\.com\/stretchr\/testify\/(assert|require)["`]$/;
const SELECTOR_WORDS = new Set([
  "min", "minimum", "smallest", "lowest", "earliest", "oldest",
  "max", "maximum", "largest", "highest", "latest", "newest",
  "canonical", "canonicalize", "canonicalise", "best",
]);
const ORDER_SENSITIVE_WORDS = new Set([
  "first", "last", "head", "tail", "ordered", "order", "stable",
  "preserve", "next", "previous",
]);

/**
 * Detect only syntactically provable direct selector assertions. The function
 * name supplies the order-independent contract; literal inputs and equality
 * oracles make survival of an always-first/always-last mutation decidable.
 */
export function selectorOracleEvidence(file: SourceRevision, tree: Tree): SelectorOracleEvidence[] {
  if (!file.path.endsWith("_test.go")) return [];

  const packageName = descendants(tree.rootNode, "package_identifier")[0];
  if (packageName === undefined) return [];
  const packageKey = `${dirname(file.path)}\0${sourceText(packageName, file.current)}`;
  const bySelector = new Map<string, SelectorOracleEvidence>();
  for (const call of descendants(tree.rootNode, "call_expression")) {
    const selector = selectorIdentity(call, file.current);
    if (selector === undefined || !isOrderIndependentSelector(selector.name)) continue;

    const expected = equalityExpected(call, file.current);
    if (expected === undefined) continue;
    const direct = directCase(call, expected, file.current);
    const table = direct === undefined ? tableCases(call, expected, file.current) : undefined;
    const cases = direct === undefined ? table : [direct];
    const evidence = bySelector.get(selector.identity) ?? {
      key: `${packageKey}\0${selector.identity}`,
      name: selector.name,
      path: file.path,
      source: file.current,
      status: file.status,
      changedLines: file.changedLines,
      calls: [],
      cases: [],
      unproven: false,
    };
    if (cases === undefined) {
      if (!knownSingletonCall(call, file.current)) evidence.unproven = true;
      bySelector.set(selector.identity, evidence);
      continue;
    }
    if (cases.length === 0) continue;

    evidence.calls.push(lineOf(call));
    evidence.cases.push(...cases);
    bySelector.set(selector.identity, evidence);
  }
  return [...bySelector.values()];
}

export function selectorOracleSignals(allEvidence: SelectorOracleEvidence[]): Signal[] {
  const signals: Signal[] = [];
  const groups = new Map<string, SelectorOracleEvidence[]>();
  for (const evidence of allEvidence) {
    const group = groups.get(evidence.key) ?? [];
    group.push(evidence);
    groups.set(evidence.key, group);
  }

  for (const group of [...groups.values()].sort((left, right) => left[0]!.key.localeCompare(right[0]!.key))) {
    if (group.some((evidence) => evidence.unproven)) continue;
    const cases = group.flatMap((evidence) => evidence.cases);
    if (cases.length === 0) continue;
    // A single applicable case is enough to expose a surviving mutation, but
    // every applicable case in the changed package must preserve the same mutation.
    const firstSurvives = cases.every((item) => item.expected === item.first);
    const lastSurvives = cases.every((item) => item.expected === item.last);
    if (!firstSurvives && !lastSurvives) continue;

    const presentation = presentationAnchor(group);
    if (presentation === undefined) continue;
    const boundary = firstSurvives ? "first" : "last";
    const name = group[0]!.name;
    signals.push({
      ruleId: "go-test.selector-boundary-oracle",
      path: presentation.evidence.path,
      line: presentation.line,
      anchors: [presentation.line],
      message: `${name} is asserted only where the expected value is the ${boundary} input; an always-${boundary} implementation would pass every applicable case.`,
      snippet: (presentation.evidence.source.split("\n")[presentation.line - 1] ?? "").trim().slice(0, 300),
      data: {
        selector: name,
        survivingMutation: `always-${boundary}`,
        applicableCases: cases.length,
      },
    });
  }
  return signals;
}

function presentationAnchor(
  group: SelectorOracleEvidence[],
): { evidence: SelectorOracleEvidence; line: number } | undefined {
  const candidates = group.flatMap((evidence) => {
    const lines = [...new Set([...evidence.calls, ...evidence.cases.flatMap((item) => item.anchors)])];
    return lines
      .filter((line) => evidence.status !== "modified" || evidence.changedLines.has(line))
      .map((line) => ({ evidence, line }));
  });
  return candidates.sort(
    (left, right) => left.evidence.path.localeCompare(right.evidence.path) || left.line - right.line,
  )[0];
}

function selectorIdentity(call: Node, source: string): { name: string; identity: string } | undefined {
  const fn = call.childForFieldName("function");
  if (fn === null) return undefined;
  if (fn.type === "identifier") {
    const name = sourceText(fn, source);
    return { name, identity: name };
  }
  if (fn.type === "selector_expression") {
    const field = fn.childForFieldName("field");
    return field === null ? undefined : {
      name: sourceText(field, source),
      identity: sourceText(fn, source),
    };
  }
  return undefined;
}

function isOrderIndependentSelector(name: string): boolean {
  const words = identifierWords(name);
  if (words.some((word) => ORDER_SENSITIVE_WORDS.has(word))) return false;
  return words.some((word) => SELECTOR_WORDS.has(word));
}

function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function equalityExpected(call: Node, source: string): Node | undefined {
  let current: Node | null = call;
  for (let depth = 0; current !== null && depth < 5; depth += 1, current = current.parent) {
    if (current.type === "binary_expression") {
      const expected = failingComparisonExpected(current, source, (candidate) => contains(candidate, call));
      if (expected !== undefined) return expected;
    }

    if (current.type !== "call_expression") continue;
    const expected = knownAssertionExpected(current, source, (candidate) => contains(candidate, call));
    if (expected !== undefined) return expected;
  }
  return immediatelyAssertedAssignment(call, source);
}

function immediatelyAssertedAssignment(call: Node, source: string): Node | undefined {
  const declaration = ancestor(call, "short_var_declaration");
  if (declaration === undefined) return undefined;
  const left = declaration.childForFieldName("left");
  const right = declaration.childForFieldName("right");
  if (left === null || right === null) return undefined;
  const rightValues = right.type === "expression_list" ? right.namedChildren : [right];
  const callIndex = rightValues.findIndex((value) => contains(value, call));
  const leftValues = left.type === "expression_list" ? left.namedChildren : [left];
  const result = leftValues[callIndex];
  if (result?.type !== "identifier") return undefined;
  const variable = sourceText(result, source);

  const statements = declaration.parent;
  if (statements?.type !== "statement_list") return undefined;
  const index = statements.namedChildren.findIndex(
    (statement) => statement.startIndex === declaration.startIndex && statement.endIndex === declaration.endIndex,
  );
  const next = statements.namedChildren[index + 1];
  if (index < 0 || next === undefined) return undefined;

  for (const assertion of descendants(next, "call_expression")) {
    const expected = knownAssertionExpected(
      assertion,
      source,
      (candidate) => candidate.type === "identifier" && sourceText(candidate, source) === variable,
    );
    if (expected !== undefined) return expected;
  }

  for (const comparison of descendants(next, "binary_expression")) {
    const expected = failingComparisonExpected(
      comparison,
      source,
      (candidate) => candidate.type === "identifier" && sourceText(candidate, source) === variable,
    );
    if (expected !== undefined) return expected;
  }
  return undefined;
}

function knownAssertionExpected(
  assertion: Node,
  source: string,
  isActual: (node: Node) => boolean,
): Node | undefined {
  const fn = assertion.childForFieldName("function");
  const args = assertion.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn === null || args.length < 3) return undefined;
  const functionName = sourceText(fn, source);
  const [receiver, method, ...extra] = functionName.split(".");
  if (extra.length > 0 || receiver === undefined || method === undefined) return undefined;
  if (!testifyReceivers(assertion, source).has(receiver) || !ASSERTION_NAMES.has(method)) return undefined;
  return isActual(args[2]!) ? args[1] : undefined;
}

function testifyReceivers(node: Node, source: string): Set<string> {
  let root = node;
  while (root.parent !== null) root = root.parent;
  const receivers = new Set<string>();
  for (const spec of descendants(root, "import_spec")) {
    const match = sourceText(spec, source).trim().match(TESTIFY_IMPORT);
    if (match === null) continue;
    const receiver = match[1] ?? match[2];
    if (receiver !== undefined && receiver !== "_" && receiver !== ".") receivers.add(receiver);
  }
  return receivers;
}

function failingComparisonExpected(
  comparison: Node,
  source: string,
  isActual: (node: Node) => boolean,
): Node | undefined {
  if (binaryOperator(comparison, source) !== "!=") return undefined;
  const conditional = ancestor(comparison, "if_statement");
  const condition = conditional?.childForFieldName("condition");
  const consequence = conditional?.childForFieldName("consequence");
  if (
    conditional === undefined || condition == null || consequence == null ||
    !contains(condition, comparison) || !hasTestingFailure(consequence, comparison, source)
  ) return undefined;

  const left = comparison.childForFieldName("left");
  const right = comparison.childForFieldName("right");
  if (left === null || right === null) return undefined;
  if (isActual(left)) return scalarNode(right) ? right : undefined;
  if (isActual(right)) return scalarNode(left) ? left : undefined;
  return undefined;
}

function hasTestingFailure(branch: Node, context: Node, source: string): boolean {
  const testVariables = testingVariables(context, source);
  if (testVariables.size === 0) return false;
  const methods = new Set(["Fatal", "Fatalf", "Error", "Errorf", "Fail", "FailNow"]);
  return descendants(branch, "call_expression").some((call) => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    return operand?.type === "identifier" && field !== null &&
      testVariables.has(sourceText(operand, source)) && methods.has(sourceText(field, source));
  });
}

function testingVariables(node: Node, source: string): Set<string> {
  let current: Node | null = node;
  while (current !== null && current.type !== "function_declaration" && current.type !== "func_literal") {
    current = current.parent;
  }
  const parameters = current?.childForFieldName("parameters");
  if (parameters === null || parameters === undefined) return new Set();
  const names = new Set<string>();
  const pattern = /([A-Za-z_]\w*)\s+\*testing\.(?:T|B)\b/g;
  for (const match of sourceText(parameters, source).matchAll(pattern)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

function binaryOperator(node: Node, source: string): string {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return "";
  return source.slice(left.endIndex, right.startIndex).trim();
}

function directCase(call: Node, expectedNode: Node, source: string): SelectorCase | undefined {
  const expected = scalarValue(expectedNode, source);
  if (expected === undefined) return undefined;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];

  for (const argument of args) {
    const elements = literalElements(argument, source);
    if (elements !== undefined && elements.length >= 2) {
      return {
        expected,
        first: elements[0]!,
        last: elements.at(-1)!,
        line: lineOf(argument),
        anchors: [lineOf(argument), ...literalAnchors(argument), lineOf(expectedNode)],
      };
    }
  }

  if (args.length >= 2) {
    const elements = args.map((argument) => scalarValue(argument, source));
    if (elements.every((item): item is string => item !== undefined)) {
      return {
        expected,
        first: elements[0]!,
        last: elements.at(-1)!,
        line: lineOf(args[0]!),
        anchors: [...args.map(lineOf), lineOf(expectedNode)],
      };
    }
  }
  return undefined;
}

function tableCases(call: Node, expectedNode: Node, source: string): SelectorCase[] | undefined {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 1) return undefined;
  const inputField = selectedField(args[0]!, source);
  const expectedField = selectedField(expectedNode, source);
  if (inputField === undefined || expectedField === undefined || inputField.owner !== expectedField.owner) {
    return undefined;
  }

  const loop = ancestor(call, "for_statement");
  const range = loop?.namedChildren.find((child) => child.type === "range_clause");
  const right = range?.childForFieldName("right");
  if (range === undefined || right === null || right === undefined || loop === undefined) return undefined;
  const table = tableComposite(loop, right, source);
  if (table === undefined) return undefined;
  const left = range.childForFieldName("left");
  if (left === null || !sourceText(left, source).split(",").map((item) => item.trim()).includes(inputField.owner)) {
    return undefined;
  }

  const body = table.childForFieldName("body");
  if (body === null) return undefined;
  const cases: SelectorCase[] = [];
  for (const rowElement of body.namedChildren) {
    const row = unwrapLiteral(rowElement);
    if (row?.type !== "literal_value") return undefined;
    const fields = keyedFields(row, source);
    const input = fields.get(inputField.field);
    const expected = fields.get(expectedField.field);
    if (input === undefined || expected === undefined) return undefined;
    const elements = literalElements(input, source);
    const expectedValue = scalarValue(expected, source);
    if (elements === undefined || expectedValue === undefined) return undefined;
    if (elements.length < 2) continue;
    cases.push({
      expected: expectedValue,
      first: elements[0]!,
      last: elements.at(-1)!,
      line: lineOf(rowElement),
      anchors: [lineOf(rowElement), lineOf(input), ...literalAnchors(input), lineOf(expected)],
    });
  }
  return cases;
}

function knownSingletonCall(call: Node, source: string): boolean {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 1) return false;
  const elements = literalElements(args[0]!, source);
  return elements?.length === 1 || scalarValue(args[0]!, source) !== undefined;
}

function tableComposite(loop: Node, rangeRight: Node, source: string): Node | undefined {
  if (rangeRight.type === "composite_literal") return rangeRight;
  if (rangeRight.type !== "identifier") return undefined;
  const variable = sourceText(rangeRight, source);
  const fn = ancestor(loop, "function_declaration");
  if (fn === undefined) return undefined;

  for (const declaration of descendants(fn, "short_var_declaration")) {
    if (declaration.startIndex >= loop.startIndex) continue;
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    if (left === null || right === null || sourceText(left, source).trim() !== variable) continue;
    const values = right.type === "expression_list" ? right.namedChildren : [right];
    if (values.length === 1 && values[0]?.type === "composite_literal") return values[0];
  }
  return undefined;
}

function selectedField(node: Node, source: string): { owner: string; field: string } | undefined {
  if (node.type !== "selector_expression") return undefined;
  const owner = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  if (owner?.type !== "identifier" || field === null) return undefined;
  return { owner: sourceText(owner, source), field: sourceText(field, source) };
}

function keyedFields(row: Node, source: string): Map<string, Node> {
  const fields = new Map<string, Node>();
  for (const element of row.namedChildren) {
    const keyed = unwrapLiteral(element);
    if (keyed?.type !== "keyed_element") continue;
    const key = keyed.childForFieldName("key");
    const value = keyed.childForFieldName("value");
    if (key === null || value === null) continue;
    fields.set(sourceText(unwrapLiteral(key) ?? key, source), unwrapLiteral(value) ?? value);
  }
  return fields;
}

function literalElements(node: Node, source: string): string[] | undefined {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    const value = stringValue(node, source);
    if (value === undefined || !value.includes(",")) return undefined;
    const elements = value.split(",").map((item) => item.trim()).filter(Boolean);
    return elements;
  }
  if (node.type !== "composite_literal") return undefined;
  const body = node.childForFieldName("body");
  if (body === null) return undefined;
  const elements: string[] = [];
  for (const child of body.namedChildren) {
    const value = scalarValue(unwrapLiteral(child) ?? child, source);
    if (value === undefined) return undefined;
    elements.push(value);
  }
  return elements;
}

function literalAnchors(node: Node): number[] {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return [lineOf(node)];
  if (node.type !== "composite_literal") return [lineOf(node)];
  const body = node.childForFieldName("body");
  if (body === null) return [lineOf(node)];
  return body.namedChildren.map((child) => lineOf(unwrapLiteral(child) ?? child));
}

function scalarValue(node: Node, source: string): string | undefined {
  const value = unwrapLiteral(node) ?? node;
  if (value.type === "interpreted_string_literal" || value.type === "raw_string_literal") {
    return stringValue(value, source);
  }
  if (["int_literal", "float_literal", "rune_literal", "true", "false", "nil"].includes(value.type)) {
    return sourceText(value, source).replaceAll("_", "");
  }
  return undefined;
}

function stringValue(node: Node, source: string): string | undefined {
  const text = sourceText(node, source);
  if (node.type === "raw_string_literal") return text.slice(1, -1);
  try {
    return JSON.parse(text) as string;
  } catch {
    return undefined;
  }
}

function scalarNode(node: Node): boolean {
  return scalarValueShape(unwrapLiteral(node) ?? node);
}

function scalarValueShape(node: Node): boolean {
  return [
    "interpreted_string_literal", "raw_string_literal", "int_literal", "float_literal",
    "rune_literal", "true", "false", "nil", "selector_expression",
  ].includes(node.type);
}

function unwrapLiteral(node: Node): Node | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && current.type === "literal_element" && current.namedChildCount === 1) {
    current = current.namedChild(0) ?? undefined;
  }
  return current;
}

function contains(parent: Node, child: Node): boolean {
  return parent.startIndex <= child.startIndex && parent.endIndex >= child.endIndex;
}

function ancestor(node: Node, type: string): Node | undefined {
  let current = node.parent;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return undefined;
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}
