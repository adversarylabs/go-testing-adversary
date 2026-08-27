# Go Testing adversary

Reviews Go tests for broken harnesses, flaky shared state, and oracles that preserve trivial selector or metadata-partition defects.

## Goals

The adversary is designed to produce a small number of high-confidence,
actionable findings grounded in concrete repository evidence. Its review should
be deterministic where possible, explicit about impact, and quiet when the
available evidence does not justify a finding.

## Scope

It evaluates Go tests and test infrastructure for synchronization, cleanup, environment isolation, network and host dependencies, TestMain behavior, and assertion reliability.

The complete detector or review inventory is maintained in
[CHECKS.md](CHECKS.md).

## Boundaries

It owns only this Go specialty. Other Go concerns remain with the corresponding `go/*` adversaries, and it does not execute or modify the target repository.
