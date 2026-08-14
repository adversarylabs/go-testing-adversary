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
      id: "go-test.testmain-defer-before-exit",
      title: "TestMain exits before deferred cleanup can run",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} TestMain function${count === 1 ? "" : "s"} terminate with deferred cleanup still pending.`,
      whyItMatters:
        "os.Exit terminates the process immediately and never runs deferred functions, so cleanup registered by TestMain is silently skipped.",
      impact: "Child processes, sockets, temporary files, and other test resources can leak across local or CI runs.",
      recommendation:
        "Run the test lifecycle in a helper that returns m.Run()'s code, then call os.Exit on the helper result after its defers have run.",
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
      id: "go-test.parallel-setenv",
      title: "Parallel test mutates process environment",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} parallel test scope${count === 1 ? "" : "s"} also mutate the process environment.`,
      whyItMatters:
        "Go deliberately panics when the same test or subtest combines Parallel with Setenv because environment variables are process-wide.",
      impact: "The test binary panics before the assertions run, blocking the package test suite.",
      recommendation:
        "Keep the test serial, or inject configuration without mutating the process environment; changing the call order does not make this combination safe.",
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
      id: "go-test.privileged-host-path-mutation",
      title: "Test mutates a privileged host path",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} test mutation${count === 1 ? "" : "s"} target privileged host filesystem state.`,
      whyItMatters:
        "Writing or deleting host-global system paths makes tests destructive, privilege-dependent, and non-hermetic even when cleanup is attempted.",
      impact: "Tests can overwrite pre-existing machine state, interfere with concurrent runs, or require elevated CI workers.",
      recommendation: "Redirect the dependency to a tree rooted at t.TempDir, or run it inside an explicitly isolated filesystem namespace.",
    },
    {
      id: "go-test.selector-boundary-oracle",
      title: "Selector tests preserve a trivial boundary implementation",
      category: "correctness",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} selector${count === 1 ? "" : "s"} are tested only with the expected value at one input boundary.`,
      whyItMatters:
        "Every applicable case also passes if the selector returns the first or last input without implementing its named order-independent contract.",
      impact: "A broken reducer can ship behind tests that stay green while exercising the intended API shape.",
      recommendation:
        "Add a reversed, shuffled, or interior-winner case so neither an always-first nor an always-last implementation can satisfy the test oracle.",
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
    {
      id: "go-test.helper-missing-helper",
      title: "Test assertion helper does not call Helper",
      category: "maintainability",
      severity: "low",
      confidence: "high",
      summary: (count) =>
        `${count} test assertion helper${count === 1 ? "" : "s"} report failures without marking themselves as helpers.`,
      whyItMatters:
        "Without Helper(), Go reports failures at the assertion helper instead of the test case that called it.",
      impact: "Failure output hides the actionable call site and makes test triage slower.",
      recommendation: "Call the testing object's Helper method before reporting a failure.",
    },
  ],
  noRiskSummary:
    "The reviewed tests use deterministic, test-owned lifecycle and state management.",
  approvalSummary:
    "I would trust the reviewed tests as repeatable evidence for the behavior they cover.",
  analyze(file) {
    const parallelSetenv = parallelSetenvSignals(file);
    const unsafeSetenvLines = new Set(
      parallelSetenv.map((signal) => signal.data.setenvLine).filter((line): line is number => typeof line === "number"),
    );
    return {
      signals: [
        ...testMainNoRunSignals(file),
        ...testMainDeferBeforeExitSignals(file),
        ...fatalInGoroutineSignals(file),
        ...parallelSetenv,
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
        ...missingHelperSignals(file),
      ],
      positives: [
        ...positive(
          file,
          "go-test.test-scoped-env",
          /\bt\.Setenv\s*\(/,
          "Environment mutation is restored by the testing runtime.",
        ).filter((item) => !unsafeSetenvLines.has(item.line)),
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
  const code = maskNonCode(file.current);
  const signals: Signal[] = [];
  const re = /\bfunc\s+TestMain\s*\(\s*(\w+)\s+\*testing\.M\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const mVar = match[1] ?? "m";
    const start = match.index ?? 0;
    const openBrace = re.lastIndex - 1;
    const closeBrace = matchingBrace(code, openBrace);
    if (closeBrace === -1) continue;
    re.lastIndex = closeBrace + 1;
    const body = code.slice(openBrace + 1, closeBrace);
    const escaped = mVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\.Run\\s*\\(`).test(body)) continue;
    const line = lineAt(file.current, start);
    const endLine = lineAt(file.current, closeBrace);
    signals.push({
      ruleId: "go-test.testmain-no-run",
      path: file.path,
      line,
      endLine,
      locality: { kind: "scope", startLine: line, endLine },
      message: `TestMain does not call ${mVar}.Run(); package tests will never execute.`,
      snippet: (match[0] ?? "").trim().slice(0, 300),
      data: { param: mVar },
    });
  }
  return signals;
}

/**
 * os.Exit bypasses every pending defer. Keep this rule deliberately narrow:
 * both the defer and os.Exit must be direct statements in TestMain, and the
 * defer must appear first. This avoids conflating mutually exclusive branches
 * or helper-owned cleanup with an executable leak path.
 */
function testMainDeferBeforeExitSignals(file: SourceRevision): Signal[] {
  const code = maskNonCode(file.current);
  const signals: Signal[] = [];
  const declaration = /\bfunc\s+TestMain\s*\(\s*([A-Za-z_]\w*)\s+\*testing\.M\s*\)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = declaration.exec(code)) !== null) {
    const openBrace = declaration.lastIndex - 1;
    const closeBrace = matchingBrace(code, openBrace);
    if (closeBrace === -1) continue;
    declaration.lastIndex = closeBrace + 1;

    const bodyStart = openBrace + 1;
    const body = code.slice(bodyStart, closeBrace);
    const deferOffset = directToken(body, /\bdefer\b/g);
    const exitOffset = directToken(body, /\bos\.Exit\s*\(/g, deferOffset === undefined ? 0 : deferOffset + 1);
    if (deferOffset === undefined || exitOffset === undefined || exitOffset < deferOffset) continue;

    const deferLine = lineAt(file.current, bodyStart + deferOffset);
    const exitLine = lineAt(file.current, bodyStart + exitOffset);
    signals.push({
      ruleId: "go-test.testmain-defer-before-exit",
      path: file.path,
      line: deferLine,
      endLine: exitLine,
      locality: { kind: "direct", anchors: [deferLine, exitLine] },
      message: "TestMain calls os.Exit while deferred cleanup is pending; those deferred functions will never run.",
      snippet: (file.current.split("\n")[deferLine - 1] ?? "").trim().slice(0, 300),
      data: { test: "TestMain", deferLine, exitLine },
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
  const code = maskNonCode(file.current);
  const re =
    /\bgo\s+func\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\}(?:\s*\([^)]*\))?\s*\(\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const body = match[1] ?? "";
    const fatal = /\bt\.(?:Fatal|Fatalf|FailNow|Skip|Skipf|SkipNow)\s*\(/.exec(body);
    if (fatal === null) continue;
    const matchStart = match.index ?? 0;
    const bodyStart = matchStart + (match[0]?.indexOf(body) ?? 0);
    const line = lineAt(file.current, matchStart);
    const fatalLine = lineAt(file.current, bodyStart + fatal.index);
    signals.push({
      ruleId: "go-test.fatal-in-goroutine",
      path: file.path,
      line,
      endLine: fatalLine,
      locality: { kind: "direct", anchors: [line, fatalLine] },
      message: "Fatal-style test API is invoked from a goroutine the test spawned.",
      snippet: (match[0] ?? "").trim().slice(0, 300),
      data: { goroutineLine: line, fatalLine },
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
 * Parallel and Setenv are mutually exclusive on one *testing.T. The testing
 * package panics for either call order. Restrict detection to direct calls in
 * one function or t.Run callback so branches and nested scopes do not get
 * conflated into a speculative finding.
 */
function parallelSetenvSignals(file: SourceRevision): Signal[] {
  const code = maskNonCode(file.current);
  const scopes: Array<{
    openBrace: number;
    closeBrace: number;
    variable: string;
    label: string;
  }> = [];

  const declaration = /\bfunc\s+(?:\([^\n)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^{}]*?)\)\s*(?:\([^{}]*\)|[^{}]*?)\{/g;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = declaration.exec(code)) !== null) {
    const openBrace = declaration.lastIndex - 1;
    const closeBrace = matchingBrace(code, openBrace);
    if (closeBrace === -1) continue;
    declaration.lastIndex = closeBrace + 1;
    for (const parameter of (declarationMatch[2] ?? "").matchAll(/\b([A-Za-z_]\w*)\s+\*testing\.T\b/g)) {
      scopes.push({
        openBrace,
        closeBrace,
        variable: parameter[1] ?? "t",
        label: declarationMatch[1] ?? "test function",
      });
    }
  }

  const callback = /\b[A-Za-z_]\w*\.Run\s*\([\s\S]{0,240}?,\s*func\s*\(\s*([A-Za-z_]\w*)\s+\*testing\.T\s*\)\s*\{/g;
  let callbackMatch: RegExpExecArray | null;
  while ((callbackMatch = callback.exec(code)) !== null) {
    const openBrace = callback.lastIndex - 1;
    const closeBrace = matchingBrace(code, openBrace);
    if (closeBrace === -1) continue;
    scopes.push({
      openBrace,
      closeBrace,
      variable: callbackMatch[1] ?? "t",
      label: "t.Run callback",
    });
  }

  const signals: Signal[] = [];
  for (const scope of scopes) {
    const bodyStart = scope.openBrace + 1;
    const body = code.slice(bodyStart, scope.closeBrace);
    const parallelOffset = directMethodCall(body, scope.variable, "Parallel");
    const setenvOffset = directMethodCall(body, scope.variable, "Setenv");
    if (parallelOffset === undefined || setenvOffset === undefined) continue;

    const parallelLine = lineAt(file.current, bodyStart + parallelOffset);
    const setenvLine = lineAt(file.current, bodyStart + setenvOffset);
    const line = Math.min(parallelLine, setenvLine);
    signals.push({
      ruleId: "go-test.parallel-setenv",
      path: file.path,
      line,
      endLine: Math.max(parallelLine, setenvLine),
      locality: { kind: "direct", anchors: [parallelLine, setenvLine] },
      message: `${scope.label} calls both ${scope.variable}.Parallel() and ${scope.variable}.Setenv(); Go will panic before the test can run.`,
      snippet: (file.current.split("\n")[line - 1] ?? "").trim().slice(0, 300),
      data: { testingParam: scope.variable, parallelLine, setenvLine },
    });
  }

  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.line}:${signal.endLine}:${String(signal.data.testingParam)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directMethodCall(body: string, variable: string, method: string): number | undefined {
  const pattern = new RegExp(`\\b${escapeRegExp(variable)}\\.${method}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (braceDepth(body, match.index) === 0) return match.index;
  }
  return undefined;
}

function directToken(body: string, pattern: RegExp, from = 0): number | undefined {
  pattern.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (braceDepth(body, match.index) === 0) return match.index;
  }
  return undefined;
}

function braceDepth(source: string, end: number): number {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
  }
  return depth;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
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
          locality: { kind: "direct", anchors: [line] },
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

/**
 * Named test helpers that report failures should mark themselves with Helper.
 * Keep this deliberately narrow: direct testing API calls only, and never
 * ordinary Test/Benchmark/Fuzz entrypoints.
 */
function missingHelperSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const code = maskNonCode(file.current);
  const declaration = /\bfunc\s+(\([^\n)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^{}]*?)\)\s*(?:\([^{}]*\)|[^{}]*?)\{/g;
  let match: RegExpExecArray | null;

  while ((match = declaration.exec(code)) !== null) {
    const receiver = match[1] ?? "";
    const name = match[2] ?? "";
    const params = match[3] ?? "";
    const openBrace = declaration.lastIndex - 1;
    const closeBrace = matchingBrace(code, openBrace);
    if (closeBrace === -1) continue;

    declaration.lastIndex = closeBrace + 1;
    const testingParams = [...params.matchAll(/\b([A-Za-z_]\w*)\s+(?:\*testing\.(?:T|B)|testing\.TB)\b/g)];
    if (testingParams.length === 0) continue;
    if (isTestEntrypoint(receiver, name, params)) continue;

    const body = code.slice(openBrace + 1, closeBrace);
    for (const testingParam of testingParams) {
      const variable = testingParam[1] ?? "";
      const escaped = escapeRegExp(variable);
      const failure = new RegExp(
        `\\b${escaped}\\.(?:Error|Errorf|Fail|FailNow|Fatal|Fatalf|Skip|Skipf|SkipNow)\\s*\\(`,
      ).exec(body);
      if (failure === null) continue;
      const helper = new RegExp(`\\b${escaped}\\.Helper\\s*\\(`).exec(body);
      if (helper !== null && helper.index < failure.index) continue;

      const start = match.index ?? 0;
      const line = file.current.slice(0, start).split("\n").length;
      const endLine = lineAt(file.current, closeBrace);
      signals.push({
        ruleId: "go-test.helper-missing-helper",
        path: file.path,
        line,
        endLine,
        locality: { kind: "scope", startLine: line, endLine },
        message: `${name} reports failures through ${variable} without calling ${variable}.Helper().`,
        snippet: file.current.slice(start, openBrace + 1).trim().slice(0, 300),
        data: { function: name, testingParam: variable },
      });
      break;
    }
  }

  return signals;
}

function isTestEntrypoint(receiver: string, name: string, params: string): boolean {
  if (receiver !== "") return false;
  if (name === "TestMain") return true;
  if (!/^(?:Test|Benchmark|Fuzz)(?:[A-Z_]|$)/.test(name)) return false;
  return /^\s*[A-Za-z_]\w*\s+\*testing\.(?:T|B|F)\s*$/.test(params);
}

function matchingBrace(code: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function maskNonCode(source: string): string {
  const chars = [...source];
  let state: "code" | "line" | "block" | "string" | "raw" | "rune" = "code";
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        state = "line";
      } else if (current === "/" && next === "*") {
        chars[index] = chars[index + 1] = " ";
        index += 1;
        state = "block";
      } else if (current === '"') {
        chars[index] = " ";
        state = "string";
      } else if (current === "`") {
        chars[index] = " ";
        state = "raw";
      } else if (current === "'") {
        chars[index] = " ";
        state = "rune";
      }
      continue;
    }

    if (current !== "\n") chars[index] = " ";
    if (state === "line" && current === "\n") state = "code";
    else if (state === "block" && current === "*" && next === "/") {
      chars[index + 1] = " ";
      index += 1;
      state = "code";
    } else if (state === "raw" && current === "`") state = "code";
    else if (state === "string" || state === "rune") {
      if (!escaped && ((state === "string" && current === '"') || (state === "rune" && current === "'"))) {
        state = "code";
      }
      escaped = !escaped && current === "\\";
      if (current !== "\\") escaped = false;
    }
  }
  return chars.join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
