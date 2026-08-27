# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-test.env-no-cleanup` | Medium | `os.Setenv` in tests instead of `t.Setenv` |
| `go-test.fatal-in-goroutine` | High | `t.Fatal` / `t.Fatalf` / `t.FailNow` / `t.Skip` called from a goroutine the test spawned |
| `go-test.hardcoded-port` | Medium | Test binds a fixed TCP port |
| `go-test.helper-missing-helper` | Low | Test assertion helper does not call Helper |
| `go-test.parallel-setenv` | High | One test or `t.Run` callback calls both `t.Parallel()` and `t.Setenv()` |
| `go-test.privileged-host-path-mutation` | Medium | Changed Go tests write, delete, rename, chmod, or otherwise mutate a proven path under `/etc`, `/usr`, `/bin`, `/sbin`, or `/var/lib` |
| `go-test.partition-boundary-oracle` | Medium | Direct tests prove distinct literal header and trailer values but omit wrong-partition absence assertions, allowing the partitions to be copied or merged |
| `go-test.cross-method-contract-coverage` | Medium | A changed behavioral test exercises only a strict subset of three or more sibling methods carrying the same newly changed returning gate |
| `go-test.selector-boundary-oracle` | Medium | Direct tests of a named order-independent selector let an always-first or always-last implementation pass every applicable multi-element case |
| `go-test.sleep-sync` | Medium | `time.Sleep` used to wait for concurrent work before asserting |
| `go-test.testmain-defer-before-exit` | Medium | TestMain exits before deferred cleanup can run |
| `go-test.testmain-no-run` | High | `TestMain` defined but never calls `m.Run()` |
| `go-test.unconditional-skip` | Low | Test begins with an unconditional `t.Skip` |
| `go-test.vacuous-absent-assert` | High | Leak or redaction assertion searches for a sentinel the fixture never configured |

`go-test.partition-boundary-oracle` is intentionally limited to direct `Get("literal-key")` assertions, or a `Get` result assigned to a local and asserted in the immediately following statement, on the same stably bound receiver's `RequestHeader`/`RequestTrailer` or `ResponseHeader`/`ResponseTrailer` accessors. It requires distinct positive literal keys in both partitions and reports only the missing counterpart-absence checks. Known empty/equality assertions close the gap. Dynamic keys, custom or non-adjacent assertions, generic `Header`/`Trailer` APIs, different or reassigned receivers, helpers outside direct tests/subtests, ambiguous bindings, unrelated edits, comment-only edits, and deletion-only changes without a current semantic anchor fail closed.

`go-test.cross-method-contract-coverage` is not a coverage-percentage or table-style rule. It requires at least three exported methods on the same production receiver to add the same receiver-helper call in a returning `if` gate, plus a changed, assertion-bearing test whose name identifies that helper contract and invokes at least one but not every affected method. Direct sibling test files are loaded as bounded read-only context so existing coverage can close the gap. A centralized gate called once, fewer than three changed methods, differently named tests, unasserted calls, production-only changes, unrelated test edits, generated/vendor/testdata paths, and complete coverage across sibling tests stay quiet.
