import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery, localizeSignal } from "../src/analyze.ts";
import type { Signal, SourceRevision } from "../src/types.ts";

const legacySource = `package sample

import (
	"net"
	"os"
	"testing"
	"time"
)

func cleanup() {}

func TestMain(m *testing.M) {
	defer cleanup()
	os.Exit(1)
}

func assertReady(t *testing.T) {
	t.Error("not ready")
}

func TestParallelEnv(t *testing.T) {
	t.Parallel()
	t.Setenv("MODE", "test")
}

func TestFatal(t *testing.T) {
	go func() {
		t.Fatal("failed")
	}()
}

func TestSkip(t *testing.T) {
	t.Skip("legacy")
}

func TestLegacy(t *testing.T) {
	time.Sleep(time.Second)
	_, _ = net.Listen("tcp", ":8080")
	_ = os.Setenv("MODE", "test")
	t.Log("old diagnostic")
}
`;

const expectedLegacyRules = [
  "go-test.env-no-cleanup",
  "go-test.fatal-in-goroutine",
  "go-test.hardcoded-port",
  "go-test.helper-missing-helper",
  "go-test.parallel-setenv",
  "go-test.sleep-sync",
  "go-test.testmain-defer-before-exit",
  "go-test.testmain-no-run",
  "go-test.unconditional-skip",
];

test("an unrelated edit suppresses every pre-existing deterministic finding", async () => {
  const signals = await analyze(legacySource, "modified", [lineOf(legacySource, 't.Log("old diagnostic")')]);
  assert.deepEqual(signals, []);
});

test("added files and repository scans retain deterministic findings", async () => {
  for (const status of ["added", "repository"] as const) {
    const signals = await analyze(legacySource, status, []);
    assert.deepEqual([...new Set(signals.map((signal) => signal.ruleId))].sort(), expectedLegacyRules);
  }
});

test("either changed relationship site emits evidence on that changed line", async () => {
  const cases = [
    ["go-test.testmain-defer-before-exit", "defer cleanup()"],
    ["go-test.testmain-defer-before-exit", "os.Exit(1)"],
    ["go-test.parallel-setenv", "t.Parallel()"],
    ["go-test.parallel-setenv", 't.Setenv("MODE", "test")'],
    ["go-test.fatal-in-goroutine", "go func() {"],
    ["go-test.fatal-in-goroutine", 't.Fatal("failed")'],
  ] as const;

  for (const [ruleId, changedText] of cases) {
    const changedLine = lineOf(legacySource, changedText);
    const result = (await analyze(legacySource, "modified", [changedLine]))
      .filter((signal) => signal.ruleId === ruleId);
    assert.equal(result.length, 1, `${ruleId}: ${changedText}`);
    assert.equal(result[0]?.line, changedLine, `${ruleId}: ${changedText}`);
    assert.equal(result[0]?.snippet, changedText, `${ruleId}: ${changedText}`);
  }
});

test("multiline goroutine findings retain both semantic sites", async () => {
  const goroutineLine = lineOf(legacySource, "go func() {");
  const fatalLine = lineOf(legacySource, 't.Fatal("failed")');
  const result = (await analyze(legacySource, "modified", [fatalLine]))
    .find((signal) => signal.ruleId === "go-test.fatal-in-goroutine");

  assert.ok(result !== undefined);
  assert.deepEqual(result.locality, { kind: "direct", anchors: [goroutineLine, fatalLine] });
  assert.deepEqual(result.data, { goroutineLine, fatalLine });
});

test("absence findings are local to their affected function scope", async () => {
  const source = `package sample
import "testing"

func setup() {}
func TestMain(m *testing.M) {
	setup()
}

func assertReady(t *testing.T) {
	t.Error("not ready")
}

func TestOther(t *testing.T) {
	t.Log("diagnostic")
}
`;
  const testMainLine = lineOf(source, "setup()", 2);
  const helperLine = lineOf(source, 't.Error("not ready")');
  const otherLine = lineOf(source, 't.Log("diagnostic")');

  const testMain = await analyze(source, "modified", [testMainLine]);
  assert.deepEqual(testMain.map((signal) => signal.ruleId), ["go-test.testmain-no-run"]);
  assert.equal(testMain[0]?.line, testMainLine);
  assert.equal(testMain[0]?.snippet, "setup()");

  const helper = await analyze(source, "modified", [helperLine]);
  assert.deepEqual(helper.map((signal) => signal.ruleId), ["go-test.helper-missing-helper"]);
  assert.equal(helper[0]?.line, helperLine);
  assert.equal(helper[0]?.snippet, 't.Error("not ready")');

  assert.deepEqual(await analyze(source, "modified", [otherLine]), []);
});

test("modified-file signals without locality metadata fail closed", () => {
  const source = "package sample\n";
  const file: SourceRevision = {
    path: "sample_test.go",
    current: source,
    changedLines: new Set([1]),
    status: "modified",
  };
  const signal: Signal = {
    ruleId: "go-test.future-rule",
    path: file.path,
    line: 1,
    message: "future rule",
    snippet: "package sample",
    data: {},
  };

  assert.deepEqual(localizeSignal(file, signal), []);
  assert.deepEqual(localizeSignal({ ...file, status: "added" }, signal), [signal]);
  assert.deepEqual(localizeSignal({ ...file, status: "repository" }, signal), [signal]);
});

async function analyze(
  current: string,
  status: SourceRevision["status"],
  changedLines: number[],
): Promise<Signal[]> {
  const result = await analyzeDiscovery({
    mode: status === "repository" ? "repository" : "diff",
    files: [{ path: "sample_test.go", current, status, changedLines: new Set(changedLines) }],
  });
  assert.deepEqual(result.parseErrors, []);
  return result.signals;
}

function lineOf(source: string, text: string, occurrence = 1): number {
  let seen = 0;
  const line = source.split("\n").findIndex((candidate) => {
    if (!candidate.includes(text)) return false;
    seen += 1;
    return seen === occurrence;
  });
  assert.notEqual(line, -1, text);
  return line + 1;
}
