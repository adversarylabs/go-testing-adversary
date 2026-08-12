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
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);

test("an unrelated edit does not surface a legacy TestMain issue", async () => {
  const repo = await repositoryWithLegacyTestMain();
  const path = "legacy_test.go";
  await writeFile(join(repo, path), legacyTestMain("new unrelated diagnostic"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "modified");
  assert.deepEqual([...discovery.files[0]!.changedLines], [11]);

  const analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(
    analysis.signals.filter((signal) => signal.ruleId === "go-test.testmain-defer-before-exit"),
    [],
  );

  const review = await changedReview(repo, [path]);
  assert.deepEqual(
    review.findings.filter((finding) => finding.ruleId === "go-test.testmain-defer-before-exit"),
    [],
  );
});

test("an added test file remains eligible in full", async () => {
  const repo = await repositoryWithLegacyTestMain();
  const path = "added_test.go";
  await writeFile(join(repo, path), legacyTestMain("added file"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "added");

  const analysis = await analyzeDiscovery(discovery);
  assert.equal(
    analysis.signals.filter((signal) => signal.ruleId === "go-test.testmain-defer-before-exit").length,
    1,
  );

  const review = await changedReview(repo, [path]);
  assert.equal(
    review.findings.filter((finding) => finding.ruleId === "go-test.testmain-defer-before-exit").length,
    1,
  );
});

async function repositoryWithLegacyTestMain(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "go-testing-discover-"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await writeFile(join(repo, "legacy_test.go"), legacyTestMain("old diagnostic"));
  await execute("git", ["add", "legacy_test.go"], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

async function changedReview(repoPath: string, changedFiles: string[]) {
  return createApp().run({
    input: {
      source: { path: repoPath },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
  });
}

function legacyTestMain(diagnostic: string): string {
  return `package fixture

import ("os"; "testing")

func cleanup() {}
func TestMain(m *testing.M) {
	defer cleanup()
	os.Exit(m.Run())
}
func TestOther(t *testing.T) {
	t.Log(${JSON.stringify(diagnostic)})
}
`;
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
