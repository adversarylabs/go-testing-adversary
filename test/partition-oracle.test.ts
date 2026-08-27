import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";

const ruleId = "go-test.partition-boundary-oracle";

async function findings(
  current: string,
  options: { previous?: string; status?: "added" | "modified"; changedLines?: number[] } = {},
) {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "base",
    files: [{
      path: "connect_ext_test.go",
      current,
      ...(options.previous === undefined ? {} : { previous: options.previous }),
      changedLines: new Set(options.changedLines ?? []),
      status: options.status ?? "added",
    }],
  });
  assert.deepEqual(analysis.parseErrors, []);
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

const vulnerable = `package connect
import (
	"testing"
	"connectrpc.com/connect/internal/assert"
)
func TestResponseMetadata(t *testing.T) {
	info := newCallInfo()
	headerValue := info.ResponseHeader().Get("x-header")
	assert.Equal(t, headerValue, "header-value")
	trailerValue := info.ResponseTrailer().Get("x-trailer")
	assert.Equal(t, trailerValue, "trailer-value")
}
`;

test("reports the source-shaped cross-partition oracle gap", async () => {
  const result = await findings(vulnerable);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 8);
  assert.deepEqual(result[0]?.data, {
    receiver: "info",
    partition: "response header/trailer",
    headerKeys: ["x-header"],
    trailerKeys: ["x-trailer"],
    missingFromHeaders: ["x-trailer"],
    missingFromTrailers: ["x-header"],
    fingerprint: JSON.stringify({
      prefix: "Response",
      headerOnly: ["x-header"],
      trailerOnly: ["x-trailer"],
      missingFromHeaders: ["x-trailer"],
      missingFromTrailers: ["x-header"],
    }),
  });
});

test("reports the exact Connect-shaped nested internal-assert pattern", async () => {
  const result = await findings(`package connect
import (
	"testing"
	"connectrpc.com/connect/internal/assert"
)
func TestContext(t *testing.T) {
	t.Run("unary_ping_error", func(t *testing.T) {
		ctx, callInfo := newClientContext(t.Context())
		_ = ctx
		callinfoOnlyValue := callInfo.ResponseHeader().Get("x-callinfo-only")
		assert.Equal(t, callinfoOnlyValue, "from-callinfo")
		errorMetaValue := callInfo.ResponseTrailer().Get("x-error-meta")
		assert.Equal(t, errorMetaValue, "from-error-meta")
	})
}
`);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.data.headerKeys, ["x-callinfo-only"]);
  assert.deepEqual(result[0]?.data.trailerKeys, ["x-error-meta"]);
});

test("the accepted empty-return assertions close the oracle", async () => {
  const result = await findings(`package connect
import (
	"testing"
	"connectrpc.com/connect/internal/assert"
)
func TestResponseMetadata(t *testing.T) {
	info := newCallInfo()
	headerValue := info.ResponseHeader().Get("x-header")
	assert.Equal(t, headerValue, "header-value")
	headerInTrailer := info.ResponseTrailer().Get("x-header")
	assert.Equal(t, headerInTrailer, "")
	trailerValue := info.ResponseTrailer().Get("x-trailer")
	assert.Equal(t, trailerValue, "trailer-value")
	trailerInHeader := info.ResponseHeader().Get("x-trailer")
	assert.Equal(t, trailerInHeader, "")
}
`);
  assert.deepEqual(result, []);
});

test("supports direct standard-library failure comparisons", async () => {
  const result = await findings(`package connect
import "testing"
func TestMetadata(t *testing.T) {
	info := newCallInfo()
	if info.ResponseHeader().Get("x-header") != "header-value" { t.Fatalf("wrong header") }
	if info.ResponseTrailer().Get("x-trailer") != "trailer-value" { t.Errorf("wrong trailer") }
}
`);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.data.headerKeys, ["x-header"]);
  assert.deepEqual(result[0]?.data.trailerKeys, ["x-trailer"]);
});

test("stays quiet unless both partitions contain distinct proven keys", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	one := newCallInfo()
	assert.Equal(t, "header", one.ResponseHeader().Get("x-only"))
	two := newCallInfo()
	assert.Equal(t, "shared", two.ResponseHeader().Get("x-shared"))
	assert.Equal(t, "shared", two.ResponseTrailer().Get("x-shared"))
}
`);
  assert.deepEqual(result, []);
});

test("does not combine different receivers or request and response partitions", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	left := newCallInfo()
	right := newCallInfo()
	assert.Equal(t, "header", left.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", right.ResponseTrailer().Get("x-trailer"))
	assert.Equal(t, "request", left.RequestTrailer().Get("x-request-trailer"))
}
`);
  assert.deepEqual(result, []);
});

test("fails closed for custom assertions, dynamic keys, and unstable receiver bindings", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestUnknownAssertion(t *testing.T) {
	info := newCallInfo()
	custom.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
func TestDynamicKey(t *testing.T) {
	info := newCallInfo()
	key := "x-header"
	assert.Equal(t, "header", info.ResponseHeader().Get(key))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
func TestReassigned(t *testing.T) {
	info := newCallInfo()
	assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	info = otherCallInfo()
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
func TestShadowedAssert(t *testing.T) {
	info := newCallInfo()
	assert := customAssertions{}
	assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
`);
  assert.deepEqual(result, []);
});

test("ignores non-test sources", async () => {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    files: [{ path: "metadata.go", current: vulnerable, changedLines: new Set(), status: "added" }],
  });
  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);
});

test("semantic locality ignores comments and unrelated edits in an existing gap", async () => {
  const comment = vulnerable.replace("\theaderValue :=", "\t// documentation\n\theaderValue :=");
  assert.deepEqual(await findings(comment, {
    previous: vulnerable,
    status: "modified",
    changedLines: [8],
  }), []);

  const unrelated = vulnerable.replace("info := newCallInfo()", "info := newCallInfo()\n\tt.Log(\"diagnostic\")");
  assert.deepEqual(await findings(unrelated, {
    previous: vulnerable,
    status: "modified",
    changedLines: [8],
  }), []);
});

test("a changed direct assertion that creates the gap is eligible evidence", async () => {
  const previous = vulnerable.replace(
    "trailerValue := info.ResponseTrailer().Get(\"x-trailer\")",
    "trailerValue := info.ResponseHeader().Get(\"x-trailer\")",
  );
  const result = await findings(vulnerable, {
    previous,
    status: "modified",
    changedLines: [10],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 10);
});

test("multiline expected values and metadata keys are direct semantic anchors", async () => {
  const current = `package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	info := newCallInfo()
	assert.Equal(t,
		"header",
		info.ResponseHeader().Get("x-header"),
	)
	assert.Equal(t,
		"trailer",
		info.ResponseTrailer().Get("x-trailer"),
	)
}
`;
  const previous = current.replace("\t\t\"trailer\",", "\t\t\"\",");
  const result = await findings(current, { previous, status: "modified", changedLines: [10] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 10);
});

test("generic Header and Trailer method names are outside the proven contract", async () => {
  const result = await findings(`package arbitrary
import ("testing"; "github.com/stretchr/testify/assert")
func TestDocument(t *testing.T) {
	doc := parseDocument()
	assert.Equal(t, "title", doc.Header().Get("title"))
	assert.Equal(t, "checksum", doc.Trailer().Get("checksum"))
}
`);
  assert.deepEqual(result, []);
});

test("supports direct subtests but not unproven assertion helpers or package globals", async () => {
  const direct = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	t.Run("response", func(t *testing.T) {
		info := newCallInfo()
		assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
		assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
	})
}
`);
  assert.equal(direct.length, 1);

  const indirect = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
var info = newCallInfo()
func checkMetadata(t *testing.T) {
	assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
func TestMetadata(t *testing.T) { checkMetadata(t) }
`);
  assert.deepEqual(indirect, []);
});

test("requires reachable direct test statements", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestConditional(t *testing.T) {
	info := newCallInfo()
	if false {
		assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
		assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
	}
}
func TestAfterReturn(t *testing.T) {
	info := newCallInfo()
	return
	assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
func TestLoop(t *testing.T) {
	info := newCallInfo()
	for range []int{1} {
		assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
		assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
	}
}
`);
  assert.deepEqual(result, []);
});

test("binds direct subtests to testing.T Run rather than method spelling", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	runner := customRunner{}
	runner.Run("not-a-subtest", func(t *testing.T) {
		info := newCallInfo()
		assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
		assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
	})
}
`);
  assert.deepEqual(result, []);
});

test("preserves lexical assertion imports and reachable post-guard evidence", async () => {
  const result = await findings(`package connect
import ("testing"; "github.com/stretchr/testify/assert")
func TestMetadata(t *testing.T) {
	if true { assert := customAssertions{}; _ = assert }
	info := newCallInfo()
	helper := func(assert int) { info := otherCallInfo(); _, _ = assert, info }
	_ = helper
	if info == nil { return }
	t.Log(info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "header", info.ResponseHeader().Get("x-header"))
	assert.Equal(t, "trailer", info.ResponseTrailer().Get("x-trailer"))
}
`);
  assert.equal(result.length, 1);
});

test("receiver-only renames preserve the semantic locality fingerprint", async () => {
  const current = vulnerable.replaceAll("info", "callInfo");
  assert.deepEqual(await findings(current, {
    previous: vulnerable,
    status: "modified",
    changedLines: [7, 8, 9, 10, 11],
  }), []);
});
