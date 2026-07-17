# ADR-0003: Shadow → supervised → autonomous lifecycle, never granted by confidence

- Status: accepted
- Date: 2026-07-17
- Deciders: principal engineer, product

## Context

An agent that writes to Salesforce or sends a Slack message is consequential. We
need a path from "idea" to "runs on its own" that earns trust with evidence, not
with a model's self-reported confidence.

## Decision

Agents move through an explicit lifecycle: observed → drafted → shadow →
supervised → (optionally) autonomous → paused/retired. Shadow runs execute the
full read + propose path and produce a diff but perform NO consequential write.
Supervised runs require a human approval bound to the exact proposed diff hash
before any write, and write exactly once (idempotency keyed on
run+version+step+capability+diff). Autonomy is never granted from a confidence
score; it requires a configured number of successful supervised runs with
matching independent-read verification, and high-risk steps can never become
unattended. Disconnecting a connector pauses every dependent agent. A global
kill switch pauses all agents and halts in-flight runs for the org.

## Consequences

- The first time an agent could do harm, a human is in the loop with the exact
  change in front of them.
- Promotion is auditable ("N verified supervised runs"), not vibes.
- Slightly more ceremony to reach autonomy; this is intentional.

## Alternatives considered

- **Confidence-threshold autopilot**: rejected — confidence is not verification,
  and it is exactly what an injection attack would inflate.
- **Always-supervised (no autonomy)**: rejected — removes most of the time
  savings for genuinely safe, repeatedly-verified workflows.
