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

interface SelectorEvidence {
  name: string;
  calls: number[];
  cases: SelectorCase[];
}

const ASSERTION_NAMES = new Set(["Equal", "EqualValues", "Exactly"]);
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
export function selectorOracleSignals(file: SourceRevision, tree: Tree): Signal[] {
  if (!file.path.endsWith("_test.go")) return [];

  const bySelector = new Map<string, SelectorEvidence>();
  const unprovenSelectors = new Set<string>();
  for (const call of descendants(tree.rootNode, "call_expression")) {
    const name = selectorName(call, file.current);
    if (name === undefined || !isOrderIndependentSelector(name)) continue;

    const expected = equalityExpected(call, file.current);
    if (expected === undefined) continue;
    const direct = directCase(call, expected, file.current);
    const table = direct === undefined ? tableCases(call, expected, file.current) : undefined;
    const cases = direct === undefined ? table : [direct];
    if (cases === undefined) {
      if (!knownSingletonCall(call, file.current)) unprovenSelectors.add(name);
      continue;
    }
    if (cases.length === 0) continue;

    const evidence = bySelector.get(name) ?? { name, calls: [], cases: [] };
    evidence.calls.push(lineOf(call));
    evidence.cases.push(...cases);
    bySelector.set(name, evidence);
  }

  const signals: Signal[] = [];
  for (const evidence of [...bySelector.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    if (unprovenSelectors.has(evidence.name)) continue;
    // A single applicable case is enough to expose a surviving mutation, but
    // every applicable case for the selector must preserve the same mutation.
    const firstSurvives = evidence.cases.every((item) => item.expected === item.first);
    const lastSurvives = evidence.cases.every((item) => item.expected === item.last);
    if (!firstSurvives && !lastSurvives) continue;

    const boundary = firstSurvives ? "first" : "last";
    const line = Math.min(...evidence.calls);
    signals.push({
      ruleId: "go-test.selector-boundary-oracle",
      path: file.path,
      line,
      anchors: [...new Set([...evidence.calls, ...evidence.cases.flatMap((item) => item.anchors)])],
      message: `${evidence.name} is asserted only where the expected value is the ${boundary} input; an always-${boundary} implementation would pass every applicable case.`,
      snippet: (file.current.split("\n")[line - 1] ?? "").trim().slice(0, 300),
      data: {
        selector: evidence.name,
        survivingMutation: `always-${boundary}`,
        applicableCases: evidence.cases.length,
      },
    });
  }
  return signals;
}

function selectorName(call: Node, source: string): string | undefined {
  const fn = call.childForFieldName("function");
  if (fn === null) return undefined;
  if (fn.type === "identifier") return sourceText(fn, source);
  if (fn.type === "selector_expression") {
    const field = fn.childForFieldName("field");
    return field === null ? undefined : sourceText(field, source);
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
      const operator = binaryOperator(current, source);
      if (operator !== "==" && operator !== "!=") continue;
      const left = current.childForFieldName("left");
      const right = current.childForFieldName("right");
      if (left === null || right === null) continue;
      if (contains(left, call)) return scalarNode(right) ? right : undefined;
      if (contains(right, call)) return scalarNode(left) ? left : undefined;
    }

    if (current.type !== "call_expression") continue;
    const fn = current.childForFieldName("function");
    const args = current.childForFieldName("arguments");
    if (fn === null || args === null) continue;
    const functionName = sourceText(fn, source).split(".").at(-1) ?? "";
    if (!ASSERTION_NAMES.has(functionName)) continue;
    const values = args.namedChildren;
    if (values.length < 3 || !contains(values[2]!, call)) continue;
    return values[1];
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
    const fn = assertion.childForFieldName("function");
    const args = assertion.childForFieldName("arguments")?.namedChildren ?? [];
    if (fn === null || args.length < 3) continue;
    const functionName = sourceText(fn, source).split(".").at(-1) ?? "";
    if (!ASSERTION_NAMES.has(functionName)) continue;
    if (args[2]?.type === "identifier" && sourceText(args[2], source) === variable) return args[1];
  }

  for (const comparison of descendants(next, "binary_expression")) {
    const operator = binaryOperator(comparison, source);
    if (operator !== "==" && operator !== "!=") continue;
    const comparisonLeft = comparison.childForFieldName("left");
    const comparisonRight = comparison.childForFieldName("right");
    if (comparisonLeft === null || comparisonRight === null) continue;
    if (comparisonLeft.type === "identifier" && sourceText(comparisonLeft, source) === variable) {
      return scalarValueShape(comparisonRight) ? comparisonRight : undefined;
    }
    if (comparisonRight.type === "identifier" && sourceText(comparisonRight, source) === variable) {
      return scalarValueShape(comparisonLeft) ? comparisonLeft : undefined;
    }
  }
  return undefined;
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
        anchors: [lineOf(argument), lineOf(expectedNode)],
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
        anchors: [lineOf(args[0]!), lineOf(expectedNode)],
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
      anchors: [lineOf(rowElement), lineOf(input), lineOf(expected)],
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
