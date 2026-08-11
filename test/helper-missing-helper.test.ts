import assert from "node:assert/strict";
import test from "node:test";
import { domain } from "../src/domain.ts";

function findings(source: string) {
  return domain.analyze({
    path: "assertions_test.go",
    current: source,
    changedLines: new Set<number>(),
    status: "added",
  }).signals.filter((signal) => signal.ruleId === "go-test.helper-missing-helper");
}

test("reports a named assertion helper that omits t.Helper", () => {
  const result = findings(`package sample
import "testing"

func assertReady(t *testing.T, ready bool) {
  if !ready {
    t.Fatalf("not ready")
  }
}`);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 4);
  assert.deepEqual(result[0]?.data, { function: "assertReady", testingParam: "t" });
});

test("reports testing.TB helpers and ignores strings and comments that mention Helper", () => {
  const result = findings(`package sample
import "testing"

func requireValue(tb testing.TB, value string) {
  // tb.Helper() belongs in the implementation, not just a comment.
  _ = "tb.Helper()"
  if value == "" {
    tb.Error("empty value")
  }
}`);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.data, { function: "requireValue", testingParam: "tb" });
});

test("stays quiet when the helper marks itself", () => {
  assert.equal(findings(`package sample
import "testing"

func assertReady(t *testing.T, ready bool) {
  t.Helper()
  if !ready {
    t.Errorf("not ready")
  }
}`).length, 0);
});

test("stays quiet for test entrypoints and helpers that do not report failures", () => {
  assert.equal(findings(`package sample
import "testing"

func TestReady(t *testing.T) {
  t.Fatal("ordinary test failure")
}

func parseFixture(t *testing.T, input string) error {
  t.Log("parsing fixture")
  return nil
}`).length, 0);
});
