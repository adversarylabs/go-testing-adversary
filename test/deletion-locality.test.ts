import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadInScopeSources, type RuleContext } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "../src/analyze.ts";
import { discoverSources } from "../src/discover.ts";

const execute = promisify(execFile);

test("deleting only t.Helper makes the affected helper scope eligible", async () => {
  const before = `package sample
import "testing"

func assertReady(t *testing.T) {
	t.Helper()
	t.Error("not ready")
}
`;
  const after = before.replace("\tt.Helper()\n", "");
  const { discovery, signals } = await changedAnalysis(before, after);

  assert.deepEqual([...discovery.files[0]!.changedLines], []);
  assert.deepEqual(discovery.files[0]!.deletedHunks, [{ afterLine: 4, deletedLines: 1 }]);
  const result = signals.filter((signal) => signal.ruleId === "go-test.helper-missing-helper");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 4);
  assert.equal(result[0]?.snippet, "func assertReady(t *testing.T) {");
  assert.deepEqual(result[0]?.data.localityChange, {
    kind: "deletion",
    afterLine: 4,
    deletedLines: 1,
  });
});

test("deleting only os.Exit(m.Run()) makes the affected TestMain scope eligible", async () => {
  const before = `package sample
import ("os"; "testing")

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
`;
  const after = before.replace("\tos.Exit(m.Run())\n", "");
  const { discovery, signals } = await changedAnalysis(before, after);

  assert.deepEqual([...discovery.files[0]!.changedLines], []);
  assert.deepEqual(discovery.files[0]!.deletedHunks, [{ afterLine: 4, deletedLines: 1 }]);
  const result = signals.filter((signal) => signal.ruleId === "go-test.testmain-no-run");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 4);
  assert.equal(result[0]?.snippet, "func TestMain(m *testing.M) {");
  assert.deepEqual(result[0]?.data.localityChange, {
    kind: "deletion",
    afterLine: 4,
    deletedLines: 1,
  });
});

test("a deletion in another function does not activate legacy absence findings", async () => {
  const before = `package sample
import "testing"

func TestMain(m *testing.M) {
	setup()
}

func assertReady(t *testing.T) {
	t.Error("not ready")
}

func TestOther(t *testing.T) {
	t.Log("remove me")
	t.Log("keep me")
}
`;
  const after = before.replace('\tt.Log("remove me")\n', "");
  const { discovery, signals } = await changedAnalysis(before, after);

  assert.deepEqual([...discovery.files[0]!.changedLines], []);
  assert.deepEqual(discovery.files[0]!.deletedHunks, [{ afterLine: 12, deletedLines: 1 }]);
  assert.deepEqual(
    signals.filter((signal) => [
      "go-test.helper-missing-helper",
      "go-test.testmain-no-run",
    ].includes(signal.ruleId)),
    [],
  );
});

async function changedAnalysis(before: string, after: string) {
  const repo = await mkdtemp(join(tmpdir(), "go-testing-deletion-"));
  const path = "sample_test.go";
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await writeFile(join(repo, path), before);
  await execute("git", ["add", path], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  await writeFile(join(repo, path), after);

  const discovery = await discoverSources(changedContext(repo, [path]));
  const analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(analysis.parseErrors, []);
  return { discovery, signals: analysis.signals };
}

function changedContext(repoPath: string, changedFiles: string[]): RuleContext {
  const change: RuleContext["change"] = {
    type: "diff",
    baseRef: "HEAD",
    headRef: "WORKTREE",
    scanMode: "changed",
    changedFiles,
    worktree: true,
  };
  return {
    repoPath,
    change,
    repoIndex: null,
    summary: {},
    cache: new Map(),
    relpath: (path) => path,
    glob: async () => [],
    rglob: async () => [],
    listInScopePaths: async () => [],
    loadInScopeSources: async (options) => loadInScopeSources(repoPath, change, options),
    model: {} as RuleContext["model"],
    observe: () => {},
    finding: () => {},
    review: {
      assessment: () => {},
      positive: () => {},
      observe: () => {},
      score: () => {},
      opinion: () => {},
    },
  };
}
