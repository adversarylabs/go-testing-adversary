# Checks — what go-testing detects

This file is the **public audit list** of detectors for the **go-testing** adversary. High-confidence test-correctness and flakiness defects in Go test code with file:line evidence — not a coverage cop or an assertion-style referee.

Runtime source of truth: [`src/spec.ts`](src/spec.ts) / [`src/rules.ts`](src/rules.ts).

**Scope:** `*_test.go` files and `TestMain` wiring. Coverage thresholds, assertion-library choice, and table-test style are explicitly not judged.

**Precision stance:** Fire on tests that are *broken* (don't run, can't fail, corrupt each other) or *flaky by construction* (sleep-based sync, fixed ports). "Not enough tests" is LLM-only and low severity, gated on substantial exported surface.

Public grounding: `go vet` testinggoroutine analyzer, `testing` package documentation (TestMain, t.Setenv, t.TempDir), and flaky-test literature.

---

## High

### `go-test.testmain-no-run`

| | |
| --- | --- |
| **What** | `TestMain` defined but never calls `m.Run()` |
| **Why** | The package's tests silently never execute — CI exits 0 having tested nothing. The worst possible test bug |
| **Looks for** | `func TestMain(m *testing.M)` bodies with no `m.Run()` call on any path |
| **Stays quiet when** | `m.Run` called (directly or via `os.Exit(m.Run())`); conditional skips that still reach `m.Run` on the normal path |
| **Public examples** | `testing` docs on TestMain; incident reports of "green CI, zero tests ran" |
| **Remediation** | Call `m.Run()` (returning its code) from TestMain |

### `go-test.fatal-in-goroutine`

| | |
| --- | --- |
| **What** | `t.Fatal` / `t.Fatalf` / `t.FailNow` / `t.Skip` called from a goroutine the test spawned |
| **Why** | Documented as invalid: FailNow calls `runtime.Goexit` on the *wrong* goroutine — the test can pass despite the failure, or hang |
| **Looks for** | Those calls inside `go func` literals within tests — vet-parity with the `testinggoroutine` analyzer |
| **Stays quiet when** | Goroutines use `t.Error`/`t.Errorf` (legal) and signal the main test goroutine to fail |
| **Public examples** | `go vet` testinggoroutine analyzer; `testing` docs: "FailNow must be called from the goroutine running the test" |
| **Remediation** | Use `t.Error` + channel/errgroup to propagate failure to the test goroutine |

### `go-test.parallel-setenv`

| | |
| --- | --- |
| **What** | One test or `t.Run` callback calls both `t.Parallel()` and `t.Setenv()` |
| **Why** | Go deliberately panics for this combination because environment variables are process-wide; changing the call order does not make it safe |
| **Looks for** | Direct `Parallel` and `Setenv` calls on the same `*testing.T` variable in one test scope |
| **Stays quiet when** | Environment setup is serial; parallel and environment calls belong to separate scopes; the calls occur in mutually exclusive branches |
| **Public examples** | Maintainer reviews in Teleport, Databricks CLI, and Terraform Provider DigitalOcean; `testing.T.Setenv` documentation |
| **Remediation** | Keep the test serial, or inject configuration without mutating process environment |

---

## Medium

### `go-test.sleep-sync`

| | |
| --- | --- |
| **What** | `time.Sleep` used to wait for concurrent work before asserting |
| **Why** | The dominant cause of flaky Go tests: too short → flakes under load; long enough → slow suite. Either way it's a race with a timer on top |
| **Looks for** | `time.Sleep` in tests followed by assertions on state another goroutine mutates; repeated sleep-and-poll loops without a deadline helper |
| **Stays quiet when** | Sleeps testing time-dependent behavior itself (rate limiters, TTLs); polling helpers with proper deadlines (`Eventually`-style); sub-millisecond scheduling yields |
| **Public examples** | Flaky-test postmortems across the industry; `testify.Eventually` / polling-with-deadline as the contrast |
| **Remediation** | Synchronize with channels/WaitGroups, or poll with a deadline — never a bare sleep |

### `go-test.hardcoded-port`

| | |
| --- | --- |
| **What** | Test binds a fixed TCP port |
| **Why** | Collides under parallel tests, repeated runs, and shared CI runners — classic "passes alone, fails in suite" flake |
| **Looks for** | `net.Listen("tcp", ":8080")`-style fixed-port literals and fixed ports in `httptest`-avoidable server setups inside `_test.go` |
| **Stays quiet when** | Port `:0` (kernel-assigned) with the actual port read back; `httptest.NewServer` (which does this correctly); container-orchestrated integration tests that document port ownership |
| **Public examples** | `httptest` docs; CI port-collision flake reports |
| **Remediation** | Listen on `:0` and read the assigned address, or use `httptest` |

### `go-test.env-no-cleanup`

| | |
| --- | --- |
| **What** | `os.Setenv` in tests instead of `t.Setenv` |
| **Why** | Leaks env mutations across tests — order-dependent failures that only reproduce in full-suite runs. `t.Setenv` (Go 1.17+) restores automatically and correctly refuses to run under `t.Parallel` |
| **Looks for** | `os.Setenv` calls in `_test.go` (module `go` directive ≥ 1.17) |
| **Stays quiet when** | `t.Setenv` used; `os.Setenv` immediately paired with a correct defer-restore *and* the test cannot use t.Setenv (helper without `*testing.T`) |
| **Public examples** | `testing.T.Setenv` docs |
| **Remediation** | Replace with `t.Setenv` |

### `go-test.selector-boundary-oracle`

| | |
| --- | --- |
| **What** | Direct tests of a named order-independent selector let an always-first or always-last implementation pass every applicable multi-element case |
| **Why** | The test exercises the API but does not prove that minimum/maximum/canonical/best-style selection actually examines the candidates |
| **Looks for** | Equality assertions around direct selector calls whose literal or keyed table inputs have at least two scalar values and whose expected result is consistently the same input boundary |
| **Stays quiet when** | Cases mix boundary positions or use an interior winner; the input is a singleton; assertions only check membership; the API explicitly promises first/last/stable order; the selector contract or literal oracle cannot be proven syntactically |
| **Remediation** | Add a reversed, shuffled, or interior-winner case that defeats both always-first and always-last mutations |

### `go-test.external-network`

| | |
| --- | --- |
| **What** | Unit tests call real external services |
| **Why** | Flaky (network, rate limits), slow, and occasionally destructive; also breaks offline/CI-sandboxed runs |
| **Looks for** | LLM-gated: http/gRPC calls in `_test.go` to non-local, non-fixture hostnames (real domains, cloud endpoints) without an integration-tag guard |
| **Stays quiet when** | `httptest` servers, localhost, testcontainers; integration tests behind build tags (`//go:build integration`) or `testing.Short()` guards |
| **Public examples** | Hermetic-testing guidance; flaky-suite postmortems |
| **Remediation** | Fake at the boundary (`httptest`, interfaces); move real-service tests behind an integration tag |

---

## Low

### `go-test.unconditional-skip`

| | |
| --- | --- |
| **What** | Test begins with an unconditional `t.Skip` |
| **Why** | A permanently skipped test is dead code that still reads as coverage; these routinely outlive the bug they dodged |
| **Looks for** | `t.Skip(...)` as the first statement with no condition; empty or reason-free skip messages |
| **Stays quiet when** | Conditional skips (`testing.Short()`, platform/env checks); skip message references a tracked issue |
| **Public examples** | Skipped-test rot discussions in most large Go repos |
| **Remediation** | Fix or delete; if it must stay, link a tracking issue in the skip reason |

### `go-test.package-untested`

| | |
| --- | --- |
| **What** | Non-trivial package with exported API and zero test files |
| **Why** | Honest staff-review signal — but an absence finding, so it stays low severity and LLM-gated to packages that matter |
| **Looks for** | LLM-only: packages with substantial exported surface (excluding generated code, `main` wiring, and pure type/const packages) lacking any `_test.go` |
| **Stays quiet when** | Generated packages; thin wiring/main packages; test coverage living in a sibling integration package (`foo_test` external tests elsewhere) |
| **Public examples** | Standard review practice |
| **Remediation** | Add tests for the load-bearing exported behavior first |

---

## Out of scope (owned elsewhere)

| Concern | Owner |
| --- | --- |
| `-race` / vet missing in CI | `go-project` (`vet-race-not-in-ci`) |
| Concurrency bugs in test helpers | `go/concurrency` |
| Test fixtures containing realistic secrets | `adversarylabs/adversary` (`fixtures.real-looking-secrets`) / `security/secrets` |
| Benchmark methodology | none — deliberately not judged |

---

## Release gates (repo checklist)

- [ ] `npm test`
- [ ] `adversary validate .`
- [ ] `adversary pack --check .`
- [ ] Five graded fixture snapshots match
- [ ] Benchmark corpus contains 50–100 unique, reachable repositories
- [ ] Runtime artifact executes without `node_modules`
- [ ] No scanned repository writes or model calls
