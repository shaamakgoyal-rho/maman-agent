# ADR-0007: Immutable execution receipts with explicit ROI provenance

- Status: accepted
- Date: 2026-07-17
- Deciders: principal engineer, product

## Context

The product's promise is verified ROI. Overstated or unfalsifiable savings would
destroy trust faster than any bug. We need a durable, honest record of what each
run actually did and how confident we are in the value it claims.

## Decision

Every run produces an immutable execution receipt (append-only table with a
mutation-forbidding trigger) recording per-step reads, proposed vs. completed
writes, verification outcome, duration, and cost. ROI carries explicit
provenance — `measured`, `inferred`, or `estimated` — and the engine never
presents an estimate as measured. Shadow runs report zero saved time (they wrote
nothing). Net value requires a configured loaded hourly rate; absent that, value
stays null rather than being invented. Aggregate reporting suppresses any cohort
below five people. The pet summarizes receipts in plain, honest language
("Updated 14 Salesforce contacts. Saved approximately 17 minutes. Execution
cost: $0.08.").

## Consequences

- Every value claim is traceable to a receipt and labeled by confidence.
- Disputes have a factual basis: the receipt says exactly what happened.
- We sometimes show "value not yet quantified" instead of a number, which is the
  honest cost of not fabricating one.

## Alternatives considered

- **Single blended ROI number**: rejected — hides the difference between a
  verified write and a projected estimate.
- **Mutable run summaries**: rejected — a value ledger that can be edited after
  the fact is not evidence.
