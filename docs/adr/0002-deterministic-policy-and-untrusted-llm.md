# ADR-0002: Deterministic policy, risk, and value; the LLM is untrusted data

- Status: accepted
- Date: 2026-07-17
- Deciders: principal engineer, security

## Context

Maman decides what an agent is allowed to do, how risky a step is, and how much
value a run produced. It also uses a language model to name patterns, summarize,
and draft AgentSpecs. A model that could influence eligibility, risk scoring,
permissions, or reported value would be both a security hole (prompt injection
from observed content) and a trust hole (inflated ROI).

## Decision

All security-, policy-, cost-, and value-bearing logic is deterministic
TypeScript with no model in the path: `packages/policy-engine` (risk boundaries,
prohibited verbs, approval requirements), `packages/agent-runtime` (spec
validation, the reconciliation recipe, the run engine), and
`packages/roi-engine` (baselines, verified time, net value). The model is used
only for semantic naming, summarization, and constrained AgentSpec drafting.
Every model output is parsed against a strict Zod schema and then policy-checked;
a draft that fails validation is rejected safely and never executed. Model
drafts never receive direct write steps. The `ModelProvider` interface has a
deterministic demo implementation so the entire product runs credential-free.

## Consequences

- Security and value claims are reproducible and testable without a model, and
  are immune to injection from observed workflow content.
- The model can improve UX (better names, clearer summaries) without ever being
  able to widen authority — the worst a compromised model can do is produce a
  draft that the deterministic validator rejects.
- More code to maintain than "let the model decide," but the boundary is the
  product's core safety guarantee.

## Alternatives considered

- **Model-scored risk/eligibility**: rejected — non-reproducible, injectable,
  and impossible to audit or defend to a security team.
- **Model-generated executable steps**: rejected — a drafted write step is a
  direct path from observed text to a consequential action.
