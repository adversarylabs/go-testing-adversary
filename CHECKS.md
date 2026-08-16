# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-test.env-no-cleanup` | Medium | `os.Setenv` in tests instead of `t.Setenv` |
| `go-test.fatal-in-goroutine` | High | `t.Fatal` / `t.Fatalf` / `t.FailNow` / `t.Skip` called from a goroutine the test spawned |
| `go-test.hardcoded-port` | Medium | Test binds a fixed TCP port |
| `go-test.helper-missing-helper` | Low | Test assertion helper does not call Helper |
| `go-test.parallel-setenv` | High | One test or `t.Run` callback calls both `t.Parallel()` and `t.Setenv()` |
| `go-test.privileged-host-path-mutation` | Medium | Changed Go tests write, delete, rename, chmod, or otherwise mutate a proven path under `/etc`, `/usr`, `/bin`, `/sbin`, or `/var/lib` |
| `go-test.selector-boundary-oracle` | Medium | Direct tests of a named order-independent selector let an always-first or always-last implementation pass every applicable multi-element case |
| `go-test.sleep-sync` | Medium | `time.Sleep` used to wait for concurrent work before asserting |
| `go-test.testmain-defer-before-exit` | Medium | TestMain exits before deferred cleanup can run |
| `go-test.testmain-no-run` | High | `TestMain` defined but never calls `m.Run()` |
| `go-test.unconditional-skip` | Low | Test begins with an unconditional `t.Skip` |
