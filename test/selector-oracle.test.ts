import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";

const ruleId = "go-test.selector-boundary-oracle";

async function findings(
  source: string,
  options: { status?: "added" | "modified"; changedLines?: number[] } = {},
) {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "base",
    files: [{
      path: "selector_test.go",
      current: source,
      changedLines: new Set(options.changedLines ?? []),
      status: options.status ?? "added",
    }],
  });
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

test("reports a direct selector whose applicable literals all preserve always-first", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimum(t *testing.T) {
	assert.Equal(t, 1, minimum([]int{1, 2}))
	assert.Equal(t, 3, minimum([]int{3, 4, 5}))
}
`);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 5);
  assert.deepEqual(result[0]?.data, {
    selector: "minimum",
    survivingMutation: "always-first",
    applicableCases: 2,
  });
});

test("reports one table-driven selector whose cases all preserve always-last", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/require")

func TestCanonicalChoice(t *testing.T) {
	tests := []struct { input []string; want string }{
		{input: []string{"draft", "stable"}, want: "stable"},
		{input: []string{"alias", "canonical"}, want: "canonical"},
	}
	for _, tt := range tests {
		got := canonicalChoice(tt.input)
		require.Equal(t, tt.want, got)
	}
}
`);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.data, {
    selector: "canonicalChoice",
    survivingMutation: "always-last",
    applicableCases: 2,
  });
});

test("keeps mixed boundaries, interior winners, and singleton-only tests quiet", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestSelectors(t *testing.T) {
	assert.Equal(t, 1, minimum([]int{1, 2}))
	assert.Equal(t, 1, minimum([]int{2, 1}))
	assert.Equal(t, 2, best([]int{1, 2, 3}))
	assert.Equal(t, 7, maximum([]int{7}))
}
`);

  assert.deepEqual(result, []);
});

test("stays quiet when another applicable case cannot be proven from literals", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimum(t *testing.T) {
	assert.Equal(t, 1, minimum([]int{1, 2}))
	input := loadFixture()
	assert.Equal(t, 4, minimum(input))
}
`);

  assert.deepEqual(result, []);
});

test("ignores membership checks, vague names, and explicitly order-sensitive APIs", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestSelectors(t *testing.T) {
	assert.Contains(t, []int{1, 2}, minimum([]int{1, 2}))
	assert.Equal(t, 1, selectValue([]int{1, 2}))
	assert.Equal(t, 1, firstMinimum([]int{1, 2}))
	assert.Equal(t, 2, stableMaximum([]int{1, 2}))
}
`);

  assert.deepEqual(result, []);
});

test("supports comma-delimited direct literals only when boundary equality is exact", async () => {
  const result = await findings(`package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimumVersion(t *testing.T) {
	assert.Equal(t, "1.2", minimumVersion("1.2,1.3"))
}
`);

  assert.equal(result.length, 1);
});

test("relationship findings are local to selector calls and applicable cases", async () => {
  const source = `package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimum(t *testing.T) {
	assert.Equal(t, 1, minimum([]int{1, 2}))
	t.Log("unrelated diagnostic")
}
`;

  assert.equal((await findings(source, { status: "modified", changedLines: [6] })).length, 0);
  assert.equal((await findings(source, { status: "modified", changedLines: [5] })).length, 1);
});

test("a changed expected value is a semantic anchor for an assigned selector call", async () => {
  const source = `package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimum(t *testing.T) {
	got := minimum([]int{1, 2})
	assert.Equal(t, 1, got)
}
`;

  const result = await findings(source, { status: "modified", changedLines: [6] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 6);
  assert.match(result[0]?.snippet ?? "", /assert\.Equal/);
});

test("requires a known assertion or a comparison that fails the Go test", async () => {
  const result = await findings(`package selector
import "testing"

func TestMinimum(t *testing.T) {
	if minimum([]int{1, 2}) != 1 { t.Log("observed") }
	custom.Equal(t, 1, minimum([]int{1, 2}))
	assert.Equal(t, 1, minimum([]int{1, 2}))
	if minimum([]int{1, 2}) != 1 { logger.Error("not a test failure") }
}
`);

  assert.deepEqual(result, []);
});

test("accepts a manual comparison only when its branch fails the Go test", async () => {
  const result = await findings(`package selector
import "testing"

func TestMinimum(t *testing.T) {
	if minimum([]int{1, 2}) != 1 {
		t.Fatalf("wrong minimum")
	}
}
`);

  assert.equal(result.length, 1);
});

test("attributes a changed multiline table value to that exact semantic line", async () => {
  const source = `package selector
import ("testing"; "github.com/stretchr/testify/require")

func TestMinimum(t *testing.T) {
	tests := []struct { input []int; want int }{
		{
			input: []int{1, 2},
			want: 1,
		},
	}
	for _, tt := range tests {
		got := minimum(tt.input)
		require.Equal(t, tt.want, got)
	}
}
`;

  const result = await findings(source, { status: "modified", changedLines: [8] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 8);
  assert.match(result[0]?.snippet ?? "", /want: 1/);
});

test("attributes a changed multiline literal element to that exact input line", async () => {
  const source = `package selector
import ("testing"; "github.com/stretchr/testify/assert")

func TestMinimum(t *testing.T) {
	assert.Equal(t, 1, minimum([]int{
		1,
		2,
	}))
}
`;

  const result = await findings(source, { status: "modified", changedLines: [7] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 7);
  assert.equal(result[0]?.snippet, "2,");
});

test("aggregates selector counterexamples across changed test files in one package", async () => {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "base",
    files: [
      {
        path: "sample/min_first_test.go",
        current: `package sample
import ("testing"; "github.com/stretchr/testify/assert")
func TestMinimumFirst(t *testing.T) { assert.Equal(t, 1, minimum([]int{1, 2})) }
`,
        changedLines: new Set<number>(),
        status: "added",
      },
      {
        path: "sample/min_last_test.go",
        current: `package sample
import ("testing"; "github.com/stretchr/testify/assert")
func TestMinimumLast(t *testing.T) { assert.Equal(t, 1, minimum([]int{2, 1})) }
`,
        changedLines: new Set<number>(),
        status: "added",
      },
    ],
  });

  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);
});
