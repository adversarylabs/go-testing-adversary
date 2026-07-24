import { lineSignals, positive } from "./signals.js";
import { type DomainDefinition } from "./types.js";

export const domain: DomainDefinition = {
  name: "go-testing",
  displayName: "Go Testing",
  observationKey: "go-testing.analysis",
  sourceDescription: "Go test",
  includePath: (path) => path.endsWith("_test.go"),
  rules: [
    {
      id: "go-testing.goroutine-assertion",
      title: "A test assertion runs from a background goroutine",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} test assertion${count === 1 ? " is" : "s are"} made from a goroutine the test does not synchronously own.`,
      whyItMatters: "Fatal-style test APIs terminate only the calling goroutine, and any assertion can race with test completion when its worker is not joined.",
      impact: "The test can pass despite a failed assertion, fail after completion, or report nondeterministically.",
      recommendation: "Return errors or results to the test goroutine and assert after the worker has been joined.",
    },
    {
      id: "go-testing.global-state",
      title: "The test mutates process state without test-scoped restoration",
      category: "reliability",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} process-global mutation${count === 1 ? "" : "s"} bypass test-scoped cleanup.`,
      whyItMatters: "Environment and process globals outlive the individual test and are shared with parallel tests.",
      impact: "Test order changes behavior and failures leak state into otherwise unrelated cases.",
      recommendation: "Use t.Setenv or register an immediate t.Cleanup that restores the exact prior value.",
    },
    {
      id: "go-testing.timing-sleep",
      title: "The test uses wall-clock sleeping as synchronization",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) => `${count} test wait${count === 1 ? " relies" : "s rely"} on a fixed sleep.`,
      whyItMatters: "A sleep proves only that time elapsed, not that the state transition under test completed.",
      impact: "The test becomes slow on every run and flaky under scheduler or CI load.",
      recommendation: "Synchronize on the observable event, inject a clock, or poll a bounded condition with a diagnostic timeout.",
    },
  ],
  noRiskSummary: "The reviewed tests use deterministic, test-owned lifecycle and state management.",
  approvalSummary: "I would trust the reviewed tests as repeatable evidence for the behavior they cover.",
  analyze(file) {
    const signals = [
      ...lineSignals(
        file,
        "go-testing.goroutine-assertion",
        /\bgo\s+func\b.*\bt\.(?:Fatal|Fatalf|FailNow|Error|Errorf)\s*\(/,
        () => "This assertion executes inside a newly launched goroutine.",
      ),
      ...lineSignals(
        file,
        "go-testing.global-state",
        /\bos\.(Setenv|Unsetenv)\s*\(/,
        (match) => `os.${match[1]} mutates environment state without test-scoped restoration.`,
        (match) => ({ operation: match[1] }),
      ),
      ...lineSignals(
        file,
        "go-testing.timing-sleep",
        /\btime\.Sleep\s*\(/,
        () => "A fixed sleep is used to wait for behavior under test.",
      ),
    ];
    const positives = [
      ...positive(file, "go-testing.test-scoped-env", /\bt\.Setenv\s*\(/, "Environment mutation is restored by the testing runtime."),
      ...positive(file, "go-testing.cleanup-owned", /\bt\.Cleanup\s*\(/, "Resource cleanup is explicitly owned by the test."),
    ];
    return { signals, positives };
  },
};
