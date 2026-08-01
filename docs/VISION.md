# Maman — vision

> Maman is an agent that earns its job. It sits on one worker's machine,
> observing only the apps they've allowed, as typed events — never screenshots,
> never keystrokes, never banking, health, or password surfaces, which are
> hard-denied in code. When it notices a workflow you've repeated, it doesn't
> offer a builder or a prompt box. It builds the agent itself, replays it
> against your own recorded runs, and shows you the score: tested against your
> last 20, matched 19. You approve every step it takes until its record says
> you don't have to. Everything it learns stays yours: local-first, per-app
> deletable, gone on demand. Maman starts as one worker's companion; the map of
> how work actually happens — the asset every agent platform is missing —
> accumulates underneath, one verified workflow at a time.

## Why this wedge

**The incumbents are converging top-down.** Celonis (Agent Mining), ServiceNow
(Zurich), Salesforce/Apromore, UiPath, Mimica, and Skan all sell
observe-to-automate to the org: install fleet-wide, mine the processes, hand
the map to operations. We do not compete there at 0.x. Maman wins the worker
first — one install, one person's repeated work, one proven helper. The org is
the expansion, not the wedge.

**Recording the screen is the bossware objection, and now a regulatory one.**
Workplace-observation rules are hardening (EU AI Act; California's employee-
surveillance bills). Architectures built on pixel capture inherit that
headwind. Maman's architecture is the counter-position, not a limitation: we
never see pixels. We see typed events, from apps you chose, and here is the
list of things we are structurally incapable of observing — password managers,
banking, health, private windows, secure fields — enforced in the observation
code itself, rendered verbatim in the product, and verifiable by the drop
counters on the "what Maman sees" page.

**Bottom-up is the proven entry.** Scribe walked this path: land with one
worker on a free, immediately-useful tool; the org account follows the users.
Maman's single-worker loop (notice → prove → draft → earn autonomy) is
valuable on day one with zero organizational buy-in, zero credentials, and
zero configuration.

**Replay-verified agents are the unowned claim.** Every agent platform ships
confidence scores, demos, and prompts. Nobody in the landscape shows you an
agent tested against _your own recorded runs_ before it asks for anything:
"I tested this against your last 21 runs and matched 19 — here are the two I
got wrong." That card — proof before trust, divergences included — is the
entire product at this stage, and everything in the codebase serves it: the
local-only replay traces (richer than anything synced, never uploaded), the
verification gate in front of every suggestion, and per-step approvals that
convert a match record into earned, worker-granted autonomy.

## The two-tier data model (privacy vs. replay, resolved)

Local data may be richer than synced data; that is the point of local-first.
Replay-fidelity traces (`episode_traces`) live only on the device, encrypted,
and are never referenced by the sync outbox. What syncs is the same coarse,
de-identified projection as before (categories, semantic tags, bucketed
counts). The verification _numbers_ travel with a suggestion; the runs that
produced them never do.

## What Maman is not

- Not a fleet product: no admin views, no aggregate dashboards, no individual
  timelines for anyone but the worker. Maman reports to you. Aggregates for
  your org are opt-in and never include individual timelines.
- Not a prompt box: if the worker has to configure or describe the workflow,
  the card has failed.
- Not autonomous by default: agents draft and stage only; autonomy is earned
  per-workflow through approved runs and granted only by the worker.
