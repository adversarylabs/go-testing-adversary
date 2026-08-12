import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { domain } from "../src/domain.ts";

async function findings(fixture: "vulnerable" | "clean-helper" | "clean-explicit" | "clean-return") {
  const path = new URL(`./fixtures/testmain-defer-before-exit/${fixture}.go`, import.meta.url);
  const current = await readFile(path, "utf8");
  return domain.analyze({
    path: `${fixture}_test.go`,
    current,
    changedLines: new Set<number>(),
    status: "added",
  });
}

test("reports deferred TestMain cleanup bypassed by os.Exit", async () => {
  const analysis = await findings("vulnerable");
  const result = analysis.signals.filter(
    (signal) => signal.ruleId === "go-test.testmain-defer-before-exit",
  );

  assert.equal(result.length, 1);
  assert.ok(
    result.every(
      (signal) =>
        typeof signal.data.deferLine === "number" &&
        typeof signal.data.exitLine === "number" &&
        signal.data.deferLine < signal.data.exitLine,
    ),
  );
  assert.ok(result.every((signal) => signal.endLine === signal.data.exitLine));
});

test("keeps cleanup that can execute before process exit clean", async () => {
  for (const fixture of ["clean-helper", "clean-explicit", "clean-return"] as const) {
    const analysis = await findings(fixture);
    assert.deepEqual(
      analysis.signals.filter(
        (signal) => signal.ruleId === "go-test.testmain-defer-before-exit",
      ),
      [],
      fixture,
    );
  }
});
