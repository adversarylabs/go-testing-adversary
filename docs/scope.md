# go/testing — mission and scope

Source of truth for what this adversary is *for*.

- **Package:** `go-testing`
- **Factory routing:** human PR comments are attributed to this adversary only when they match **In scope**.
- **Languages / surfaces:** Go tests

## Mission

Review Go tests for correctness of the test harness and concurrency/sync mistakes in tests.

## In scope (fair miss if humans raised it and we did not)

- TestMain mistakes; t.Fatal in goroutines
- Sleep-based synchronization; fixed ports; env leakage
- Tests that claim to cover concurrent behavior but do not
- Flaky or incorrect assertions that hide real failures
- Leak/redaction tests that assert a sentinel is absent when the fixture never contains that sentinel
- Direct selector tests whose literal equality oracles do not distinguish the named order-independent behavior from returning a fixed input boundary

## Out of scope (not a miss for this adversary)

- Production code correctness (unless only visible via tests)
- Style of test names
- Non-Go

## Factory grading rule

- **In scope + human raised it + this adversary did not surface it** → real miss → suggested issue for **this** package
- **Out of scope** → do not grade as a miss for this adversary
- **Better fit for another adversary** → route there; do not double-count as a miss here
- **Unclear** → prefer out-of-scope for grading
