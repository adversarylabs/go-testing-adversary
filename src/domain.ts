import { lineSignals, positive } from "./signals.js";
import { type DomainDefinition, type Signal, type SourceRevision } from "./types.js";

export const domain: DomainDefinition = {
  // Catalog / package identity uses domain/name taxonomy.
  name: "go/testing",
  displayName: "Go Testing",
  observationKey: "go-testing.analysis",
  sourceDescription: "Go test",
  includePath: (path) => path.endsWith("_test.go"),
  rules: [
    {
      id: "go-test.testmain-no-run",
      title: "TestMain never calls m.Run",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} TestMain function${count === 1 ? "" : "s"} never execute the package tests.`,
      whyItMatters:
        "Without m.Run(), the package's tests silently never execute — CI exits 0 having tested nothing.",
      impact: "Green CI with zero tests run — the worst possible test bug.",
      recommendation: "Call m.Run() (returning its code) from TestMain.",
    },
    {
      id: "go-test.fatal-in-goroutine",
      title: "t.Fatal/FailNow/Skip called from a test-spawned goroutine",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} fatal-style test call${count === 1 ? "" : "s"} run on a background goroutine.`,
      whyItMatters:
        "FailNow calls runtime.Goexit on the wrong goroutine — the test can pass despite the failure, or hang.",
      impact: "False greens and hangs under race/CI scheduling.",
      recommendation: "Use t.Error + channel/errgroup to propagate failure to the test goroutine.",
    },
    {
      id: "go-test.sleep-sync",
      title: "time.Sleep used to wait for concurrent work",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} test wait${count === 1 ? "" : "s"} rely on a fixed sleep for synchronization.`,
      whyItMatters:
        "Sleeps race the scheduler: too short flakes; long enough slows the suite.",
      impact: "Flaky CI under load and permanently slow tests.",
      recommendation:
        "Synchronize with channels/WaitGroups, or poll with a deadline — never a bare sleep.",
    },
    {
      id: "go-test.hardcoded-port",
      title: "Test binds a fixed TCP port",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} test listener${count === 1 ? "" : "s"} bind a fixed port.`,
      whyItMatters:
        "Fixed ports collide under parallel tests, repeated runs, and shared CI runners.",
      impact: "Passes alone, fails in suite — classic port-collision flake.",
      recommendation: "Listen on :0 and read the assigned address, or use httptest.",
    },
    {
      id: "go-test.env-no-cleanup",
      title: "os.Setenv mutates process env without t.Setenv",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} environment mutation${count === 1 ? "" : "s"} bypass test-scoped restoration.`,
      whyItMatters:
        "Leaked env mutations cause order-dependent failures that only reproduce in full-suite runs.",
      impact: "Parallel and suite-ordered tests become flaky and non-hermetic.",
      recommendation: "Replace with t.Setenv (Go 1.17+).",
    },
    {
      id: "go-test.unconditional-skip",
      title: "Test begins with an unconditional t.Skip",
      category: "maintainability",
      severity: "low",
      confidence: "high",
      summary: (count) =>
        `${count} test${count === 1 ? "" : "s"} are permanently skipped with no condition.`,
      whyItMatters:
        "A permanently skipped test is dead code that still reads as coverage and outlives the bug it dodged.",
      impact: "False sense of coverage; skipped suites rot.",
      recommendation: "Fix or delete; if it must stay, link a tracking issue in the skip reason.",
    },
  ],
  noRiskSummary:
    "The reviewed tests use deterministic, test-owned lifecycle and state management.",
  approvalSummary:
    "I would trust the reviewed tests as repeatable evidence for the behavior they cover.",
  analyze(file) {
    return {
      signals: [
        ...testMainNoRunSignals(file),
        ...fatalInGoroutineSignals(file),
        ...lineSignals(
          file,
          "go-test.sleep-sync",
          /\btime\.Sleep\s*\(/,
          () => "A fixed sleep is used to wait for behavior under test.",
        ),
        ...lineSignals(
          file,
          "go-test.hardcoded-port",
          /\b(?:net\.)?Listen\s*\(\s*["']tcp["']\s*,\s*["']:(?!0["'])\d{2,5}["']/,
          () => "Listener binds a fixed TCP port instead of :0.",
        ),
        ...lineSignals(
          file,
          "go-test.hardcoded-port",
          /\b(?:http\.)?ListenAndServe\s*\(\s*["']:(?!0["'])\d{2,5}["']/,
          () => "Server listens on a fixed TCP port instead of :0.",
        ),
        ...lineSignals(
          file,
          "go-test.env-no-cleanup",
          /\bos\.(Setenv|Unsetenv)\s*\(/,
          (match) => `os.${match[1]} mutates environment state without t.Setenv.`,
          (match) => ({ operation: match[1] }),
        ),
        ...unconditionalSkipSignals(file),
      ],
      positives: [
        ...positive(
          file,
          "go-test.test-scoped-env",
          /\bt\.Setenv\s*\(/,
          "Environment mutation is restored by the testing runtime.",
        ),
        ...positive(
          file,
          "go-test.cleanup-owned",
          /\bt\.Cleanup\s*\(/,
          "Resource cleanup is explicitly owned by the test.",
        ),
        ...positive(
          file,
          "go-test.port-ephemeral",
          /Listen\s*\(\s*["']tcp["']\s*,\s*["']:0["']/,
          "Listener uses an ephemeral port.",
        ),
      ],
    };
  },
};

function testMainNoRunSignals(file: SourceRevision): Signal[] {
  if (!/\bfunc\s+TestMain\s*\(/.test(file.current)) return [];
  // If m.Run appears anywhere in the file's TestMain scope, quiet.
  // Capture each TestMain body roughly until next top-level func.
  const signals: Signal[] = [];
  const re = /\bfunc\s+TestMain\s*\(\s*(\w+)\s+\*testing\.M\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(file.current)) !== null) {
    const mVar = match[1] ?? "m";
    const start = match.index ?? 0;
    const rest = file.current.slice(start);
    const nextFunc = rest.slice(1).search(/\nfunc\s+/);
    const body = nextFunc === -1 ? rest : rest.slice(0, nextFunc + 1);
    const escaped = mVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Require a real call site — comments like "forgot m.Run()" must not quiet this.
    if (new RegExp(`\\b${escaped}\\.Run\\s*\\(`).test(body.replace(/\/\/[^\n]*/g, " "))) continue;
    const line = file.current.slice(0, start).split("\n").length;
    signals.push({
      ruleId: "go-test.testmain-no-run",
      path: file.path,
      line,
      message: `TestMain does not call ${mVar}.Run(); package tests will never execute.`,
      snippet: (match[0] ?? "").trim().slice(0, 300),
      data: { param: mVar },
    });
  }
  return signals;
}

function fatalInGoroutineSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  // Same-line go func() { t.Fatal...
  signals.push(
    ...lineSignals(
      file,
      "go-test.fatal-in-goroutine",
      /\bgo\s+func\b[^;\n]*\bt\.(?:Fatal|Fatalf|FailNow|Skip|Skipf|SkipNow)\s*\(/,
      () => "Fatal-style test API is invoked from a newly launched goroutine.",
    ),
  );
  // Multi-line go func bodies.
  const re =
    /\bgo\s+func\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\}(?:\s*\([^)]*\))?\s*\(\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(file.current)) !== null) {
    const body = match[1] ?? "";
    if (!/\bt\.(?:Fatal|Fatalf|FailNow|Skip|Skipf|SkipNow)\s*\(/.test(body)) continue;
    // t.Error is legal — already excluded by pattern.
    const line = file.current.slice(0, match.index ?? 0).split("\n").length;
    signals.push({
      ruleId: "go-test.fatal-in-goroutine",
      path: file.path,
      line,
      message: "Fatal-style test API is invoked from a goroutine the test spawned.",
      snippet: (match[0] ?? "").trim().slice(0, 300),
      data: {},
    });
  }
  const seen = new Set<number>();
  return signals.filter((s) => {
    if (seen.has(s.line)) return false;
    seen.add(s.line);
    return true;
  });
}

/**
 * t.Skip as the first statement of a Test* function with no surrounding condition.
 */
function unconditionalSkipSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const re = /\bfunc\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(file.current)) !== null) {
    const start = (match.index ?? 0) + match[0].length;
    const rest = file.current.slice(start);
    // First non-empty, non-comment statement.
    const lines = rest.split("\n");
    for (let i = 0; i < Math.min(lines.length, 12); i += 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
      if (trimmed === "{") continue;
      // Conditional skip forms stay quiet.
      if (/^if\b/.test(trimmed)) break;
      if (/^switch\b/.test(trimmed)) break;
      if (/\bt\.Skip(?:f|Now)?\s*\(/.test(trimmed)) {
        const line =
          file.current.slice(0, start).split("\n").length + i;
        signals.push({
          ruleId: "go-test.unconditional-skip",
          path: file.path,
          line,
          message: `${match[1]} begins with an unconditional t.Skip.`,
          snippet: trimmed.slice(0, 300),
          data: { test: match[1] },
        });
      }
      break;
    }
  }
  return signals;
}
