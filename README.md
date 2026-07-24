# Go Testing adversary

Go Testing reviews whether changed tests provide deterministic, isolated, trustworthy evidence.

It currently reviews:

- assertions made from unowned background goroutines
- process-global environment mutation without test-scoped restoration
- wall-clock sleeping used as synchronization

Related evidence is grouped by remediation, and overall risk follows the most operationally important defect rather than the number of findings.

## Fixtures and calibration

`fixtures/` contains `excellent`, `good`, `average`, `poor`, and `terrible` repositories with expected review snapshots. `benchmarks/corpus.json` indexes 61 external Go repositories used for calibration; no upstream source is copied.

## Automatic detection

`adversary auto` selects Go Testing when a Go test file changes.

## Development

```sh
npm ci
npm test
adversary validate .
adversary pack --check .
```
