import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { domain } from "../src/domain.ts";

async function findings(fixture: "vulnerable" | "clean") {
  const path = new URL(`./fixtures/parallel-setenv/${fixture}.go`, import.meta.url);
  const current = await readFile(path, "utf8");
  return {
    analysis: domain.analyze({
      path: `${fixture}_test.go`,
      current,
      changedLines: new Set<number>(),
      status: "added",
    }),
  };
}

test("reports top-level and subtest Parallel plus Setenv conflicts", async () => {
  const { analysis } = await findings("vulnerable");
  const result = analysis.signals.filter((signal) => signal.ruleId === "go-test.parallel-setenv");

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((signal) => signal.data.testingParam), ["t", "tb"]);
  assert.ok(result.every((signal) => signal.data.parallelLine !== signal.data.setenvLine));
  assert.equal(
    analysis.positives.filter((positive) => positive.key === "go-test.test-scoped-env").length,
    0,
    "unsafe Setenv calls must not also be praised as test-scoped cleanup",
  );
});

test("keeps serial setup, unrelated scopes, and exclusive branches clean", async () => {
  const { analysis } = await findings("clean");
  assert.deepEqual(
    analysis.signals.filter((signal) => signal.ruleId === "go-test.parallel-setenv"),
    [],
  );
  assert.equal(
    analysis.positives.filter((positive) => positive.key === "go-test.test-scoped-env").length,
    3,
  );
});
