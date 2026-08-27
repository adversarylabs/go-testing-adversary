import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import type { SourceRevision } from "../src/types.ts";

const ruleId = "go-test.cross-method-contract-coverage";

const production = `package workload

type Handler struct{}

func (h *Handler) rateLimit(method string) error { return nil }

func (h *Handler) FetchX509SVID() error {
	if err := h.rateLimit("FetchX509SVID"); err != nil { return err }
	return nil
}

func (h *Handler) FetchJWTSVID() error {
	if err := h.rateLimit("FetchJWTSVID"); err != nil { return err }
	return nil
}

func (h *Handler) FetchX509Bundles() error {
	if err := h.rateLimit("FetchX509Bundles"); err != nil { return err }
	return nil
}

func (h *Handler) FetchJWTBundles() error {
	if err := h.rateLimit("FetchJWTBundles"); err != nil { return err }
	return nil
}
`;

const incompleteTest = `package workload
import "testing"

func TestRateLimitAgentExemption(t *testing.T) {
	c := newClient()
	resp, err := c.FetchJWTSVID()
	if err != nil { t.Fatal(err) }
	if resp == nil { t.Fatal("missing response") }
}
`;

const productionBeforeGate = `package workload
type Handler struct{}
func (h *Handler) rateLimit(method string) error { return nil }
`;

const completeTableTest = `package workload
import "testing"

func TestRateLimitAgentExemption(t *testing.T) {
	for _, tt := range []struct {
		name string
		invoke func(*testing.T, *Client)
	}{
		{name: "FetchX509SVID", invoke: func(t *testing.T, c *Client) { _, err := c.FetchX509SVID(); if err != nil { t.Fatal(err) } }},
		{name: "FetchJWTSVID", invoke: func(t *testing.T, c *Client) { _, err := c.FetchJWTSVID(); if err != nil { t.Fatal(err) } }},
		{name: "FetchX509Bundles", invoke: func(t *testing.T, c *Client) { _, err := c.FetchX509Bundles(); if err != nil { t.Fatal(err) } }},
		{name: "FetchJWTBundles", invoke: func(t *testing.T, c *Client) { _, err := c.FetchJWTBundles(); if err != nil { t.Fatal(err) } }},
	} {
		t.Run(tt.name, func(t *testing.T) { tt.invoke(t, newClient()) })
	}
}
`;

function allLines(source: string): Set<number> {
  return new Set(source.split("\n").map((_, index) => index + 1));
}

function productionFile(source = production, changedLines = allLines(source)): SourceRevision {
  return {
    path: "pkg/workload/handler.go",
    current: source,
    contextOnly: true,
    previous: productionBeforeGate,
    changedLines,
    status: "modified",
  };
}

function testFile(
  source: string,
  options: Partial<Pick<SourceRevision, "path" | "contextOnly" | "status" | "changedLines">> = {},
): SourceRevision {
  return {
    path: options.path ?? "pkg/workload/handler_test.go",
    current: source,
    ...(options.contextOnly === undefined ? {} : { contextOnly: options.contextOnly }),
    changedLines: options.changedLines ?? allLines(source),
    status: options.status ?? "added",
  };
}

async function findings(files: SourceRevision[]) {
  const analysis = await analyzeDiscovery({ mode: "diff", base: "base", files });
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

test("reports the source-shaped test that covers only one of four independently gated methods", async () => {
  const result = await findings([productionFile(), testFile(incompleteTest)]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.data, {
    helper: "rateLimit",
    receiverType: "Handler",
    coveredMethods: ["FetchJWTSVID"],
    missingMethods: ["FetchJWTBundles", "FetchX509Bundles", "FetchX509SVID"],
  });
  assert.match(result[0]?.message ?? "", /same changed gate/);
});

test("follows a callback only through a same-file helper that directly invokes its function parameter", async () => {
  const wrapped = `${incompleteTest}\nfunc runTest(t *testing.T, fn func(*Client)) { fn(newClient()) }\n`
    .replace("c := newClient()", "runTest(t, func(c *Client) {")
    .replace("\tif resp == nil { t.Fatal(\"missing response\") }", "\tif resp == nil { t.Fatal(\"missing response\") }\n\t})");
  assert.equal((await findings([productionFile(), testFile(wrapped)])).length, 1);

  const inert = wrapped.replace("fn(newClient())", "_ = fn");
  assert.deepEqual(await findings([productionFile(), testFile(inert)]), []);

  const conditional = wrapped.replace("fn(newClient())", "if enabled() { fn(newClient()) }");
  assert.deepEqual(await findings([productionFile(), testFile(conditional)]), []);

  const reassigned = wrapped.replace("fn(newClient())", "fn = otherCallback; fn(newClient())");
  assert.deepEqual(await findings([productionFile(), testFile(reassigned)]), []);

  const shadowed = wrapped.replace(
    "runTest(t, func(c *Client)",
    "runTest := func(*testing.T, func(*Client)) {}\n\trunTest(t, func(c *Client)",
  );
  assert.deepEqual(await findings([productionFile(), testFile(shadowed)]), []);
});

test("keeps the accepted table-driven all-method expansion quiet", async () => {
  assert.deepEqual(await findings([productionFile(), testFile(completeTableTest)]), []);
});

test("does not count dormant or conditional table callbacks as method coverage", async () => {
  const dormantTable = completeTableTest
    .replace(
      "func TestRateLimitAgentExemption(t *testing.T) {",
      "func TestRateLimitAgentExemption(t *testing.T) {\n\tif _, err := newClient().FetchJWTSVID(); err != nil { t.Fatal(err) }",
    )
    .replace(
      "t.Run(tt.name, func(t *testing.T) { tt.invoke(t, newClient()) })",
      "if false { t.Run(tt.name, func(t *testing.T) { tt.invoke(t, newClient()) }) }",
    );
  assert.equal((await findings([productionFile(), testFile(dormantTable)])).length, 1);
});

test("uses unchanged direct sibling tests as context that can close the gap", async () => {
  const sibling = incompleteTest
    .replace("TestRateLimitAgentExemption", "TestRateLimitAgentExemptionOtherMethods")
    .replace(
      "resp, err := c.FetchJWTSVID()",
      "_, err := c.FetchX509SVID(); _, _ = c.FetchX509Bundles(); resp, _ := c.FetchJWTBundles()",
    );
  assert.deepEqual(await findings([
    productionFile(),
    testFile(incompleteTest),
    testFile(sibling, { path: "pkg/workload/other_test.go", contextOnly: true, status: "context", changedLines: new Set() }),
  ]), []);
});

test("does not become a generic coverage or table-style rule", async () => {
  const twoMethods = production.replace(/\nfunc \(h \*Handler\) FetchX509Bundles[\s\S]*$/, "\n");
  const unrelatedName = incompleteTest.replace("TestRateLimitAgentExemption", "TestClientRequest");
  const noOracle = incompleteTest
    .replace("resp, err := c.FetchJWTSVID()", "_, _ = c.FetchJWTSVID()")
    .replace(/\n\tif err[\s\S]*?\n}/, "\n}");

  assert.deepEqual(await findings([productionFile(twoMethods), testFile(incompleteTest)]), []);
  assert.deepEqual(await findings([productionFile(), testFile(unrelatedName)]), []);
  assert.deepEqual(await findings([productionFile(), testFile(noOracle)]), []);
});

test("requires the repeated returning helper gate to be changed in production", async () => {
  assert.deepEqual(await findings([productionFile(production, new Set()), testFile(incompleteTest)]), []);

  const central = `package workload
type Handler struct{}
func (h *Handler) rateLimit(method string) error { return nil }
func (h *Handler) dispatch(method string) error {
	if err := h.rateLimit(method); err != nil { return err }
	return nil
}
func (h *Handler) FetchX509SVID() error { return h.dispatch("x509") }
func (h *Handler) FetchJWTSVID() error { return h.dispatch("jwt") }
func (h *Handler) FetchX509Bundles() error { return h.dispatch("bundles") }
`;
  assert.deepEqual(await findings([productionFile(central), testFile(incompleteTest)]), []);
});

test("ignores dormant method calls that do not execute from the test", async () => {
  const dormant = incompleteTest.replace(
    "resp, err := c.FetchJWTSVID()",
    `unused := func() { _, _ = c.FetchX509SVID(); _, _ = c.FetchX509Bundles(); _, _ = c.FetchJWTBundles() }
	_ = unused
	resp, err := c.FetchJWTSVID()`,
  );
  assert.equal((await findings([productionFile(), testFile(dormant)])).length, 1);

  const unreachable = incompleteTest.replace(
    "resp, err := c.FetchJWTSVID()",
    `resp, err := c.FetchJWTSVID()
	return
	_, _ = c.FetchX509SVID()
	_, _ = c.FetchX509Bundles()
	_, _ = c.FetchJWTBundles()`,
  );
  assert.equal((await findings([productionFile(), testFile(unreachable)])).length, 1);

  const dormantIifeOracle = incompleteTest
    .replace("if err != nil { t.Fatal(err) }", "if false { func() { t.Fatal(err) }() }")
    .replace("if resp == nil { t.Fatal(\"missing response\") }", "_ = resp");
  assert.deepEqual(await findings([productionFile(), testFile(dormantIifeOracle)]), []);

  const executedIife = incompleteTest.replace(
    "resp, err := c.FetchJWTSVID()",
    "var resp any\n\tvar err error\n\tfunc() { resp, err = c.FetchJWTSVID() }()",
  );
  assert.equal((await findings([productionFile(), testFile(executedIife)])).length, 1);
});

test("relationship locality ignores unrelated and comment-only test edits", async () => {
  const modified = testFile(incompleteTest, { status: "modified", changedLines: new Set([3]) });
  assert.deepEqual(await findings([productionFile(), modified]), []);

  const callLine = incompleteTest.split("\n").findIndex((line) => line.includes("FetchJWTSVID")) + 1;
  const result = await findings([
    productionFile(),
    testFile(incompleteTest, { status: "modified", changedLines: new Set([callLine]) }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, callLine);
});

test("comment-only edits inside existing production gates do not make the relationship new", async () => {
  const commented = production.replace(
    'h.rateLimit("FetchX509SVID")',
    'h.rateLimit(\n\t\t// documentation only\n\t\t"FetchX509SVID",\n\t)',
  );
  const commentLine = commented.split("\n").findIndex((line) => line.includes("documentation only")) + 1;
  const file = productionFile(commented, new Set([commentLine]));
  file.previous = production;
  assert.deepEqual(await findings([file, testFile(incompleteTest)]), []);
});

test("context-only production and sibling tests do not count as scanned files", async () => {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "base",
    files: [productionFile(), testFile(incompleteTest)],
  });
  assert.equal(analysis.filesScanned, 1);
});
