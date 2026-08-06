# Maman (maman-agent) — agent working instructions

Maman is a macOS desktop pet that observes permitted workflows, detects repeated work,
and compiles safe, policy-checked helper agents with shadow runs, human approvals, and
verified ROI. The full build specification lives in the original build spec; the
distilled rules below are binding for all code in this repository.

## Non-negotiable safety rules

- Never capture keystrokes, passwords, auth fields, payment fields, private-browsing
  content, password-manager content, or raw screen recordings by default.
- Never weaken authorization, tenant isolation, redaction, approval checks, or audit
  logging to make a test pass.
- LLM output is untrusted data: parse against strict Zod schemas, policy-check, and
  reject safely. The LLM may never change eligibility, risk, permissions, or value.
- **Raw typed input is never collected.** No exceptions, no setting, no mode. Nothing
  in this codebase reads a key event.
- **Pixels leave the device only inside an explicit Teach Mode session**, and only
  after the on-device redaction pass has cleared the frame. This AMENDS the earlier
  rule "raw captured pixels never cross the device boundary", which was true until
  Teach Mode (M33) and is no longer. The owner authorised the change deliberately,
  in exchange for vision-derived action inference; the constraints that survive it
  are not negotiable and are enforced in `packages/teach-mode/src/redact.ts`:
  - A session is user-started, scoped to chosen apps, and self-terminating (≤900s).
    There is no default-on capture and no way to leave it running.
  - `frameEgressDecision` FAILS CLOSED: no session, an expired box, a paused user,
    an unidentifiable app, a hard-denied app, a private app (including Maman
    itself), private browsing, a focused secure field, an out-of-scope app, or a
    frame that would be more mask than picture — every one refuses the whole frame.
  - Credential-shaped regions are masked BEFORE egress, because "secret material
    never enters prompts" was not waived and a frame is now prompt content.
  - Pixels are never persisted, synced or logged. `containsForbiddenEventField`
    still rejects any payload with a `screenshot` field; frames are interpreted and
    discarded, and only the derived canonical event is stored.
  - Vision output cannot assert eligibility, risk, permissions or value — not
    "is checked afterwards", but has nowhere to put them (`visionActionSchema`).
  - Teach Mode is a THIRD source, not a replacement: it emits the same canonical
    token, and its readings can be wrong rather than merely incomplete, so they are
    dropped below a confidence floor and always attributed to `teach_mode`.
  - Any user-facing copy describing what Maman can see must be updated in the same
    change as any alteration to the above. The product must not describe behaviour
    it does not have.
- Secret material never enters logs, analytics, prompts, or AgentSpec.
- Cross-tenant resources return 404 (never 403). Every repository call requires TenantContext.
- Deterministic logic for security, policy, cost, and workflow execution. LLM only for
  semantic naming, summarization, and constrained AgentSpec generation.

## Architecture

Five processes: Tauri desktop app, Swift observer sidecar (no network code), Chrome MV3
extension, Fastify API + Next.js admin, Temporal worker. See ARCHITECTURE.md.

Package boundaries (lint-enforced — packages must not import from apps):

- `packages/contracts` — all cross-process Zod schemas and types
- `packages/db` — Drizzle schema, migrations, tenant-scoped repositories
- `packages/pattern-engine`, `packages/policy-engine`, `packages/roi-engine` — pure,
  deterministic TypeScript; no UI/network/DB imports; policy-engine must never call an LLM
- `packages/agent-runtime` — AgentSpec validation + Temporal workflow definitions
- `packages/capability-catalog` — capability metadata and adapter interfaces
- `packages/model-provider` — Anthropic + deterministic demo implementations
- `packages/config` — product identity, design tokens, env validation

## Pet rendering (Seedy atlas — binding)

- Production pet renderer is the pixel-art `SpritesheetPetRenderer`
  (`apps/desktop/src/pet/SpriteMaman.tsx`), spriteVersionNumber 2.
- Atlas: `apps/desktop/src/pet/assets/maman-atlas.webp` — 1536×2288, 8×11 grid of
  192×208 cells, transparent WebP. **The pet uses the "Seedy" pixel-art
  spritesheet, vendored with the owner's authorization** (the project owner owns
  Seedy; authorization given 2026-07-20, superseding the earlier
  "original-character / never bundle Seedy" rule). The authoritative source is
  committed under `apps/desktop/src/pet/assets/seedy-source/` (spritesheet +
  `pet.json` + `character-brief.md` + `look-mechanics.md` + `README.md` + contact
  sheet + generation artifacts: `canonical-base.png`, `look-row-10-registration.json`,
  `pet-request.json`); `apps/desktop/scripts/generate-spritesheet.ts` reproduces
  the rendered atlas by copying that vendored source (committed
  `maman-atlas.webp` is sha256-identical to the source `spritesheet.webp`), so
  provenance stays auditable. `look-row-10-registration.json` (`scale: 0.684`) is
  a generation-time calibration already baked into the committed atlas — the
  renderer applies NO per-row scale. The atlas contract (row layout) is unchanged,
  so the scheduler/renderer/gaze are unaffected.
- Animation rows/timings are locked in `apps/desktop/src/pet/atlas.ts`. No CSS
  keyframes for sprite animation — the deterministic `FrameScheduler` owns timing.
- Idle plays at 6× slow timing; transients play 3 cycles then slow idle; state
  changes cancel timers; reduced motion shows a single frame.
- 16-direction gaze (rows 9–10, 22.5° quantization, 18px dead zone) activates only
  on hover/interaction — never continuous cursor tracking.
- Dev inspection: `lab.html` (Pet Lab) with the full demo sequence.

## Conventions

- Node >= 24, pnpm workspaces, Turborepo. Internal packages export TypeScript source
  directly (`"exports": { ".": "./src/index.ts" }`); apps bundle themselves.
- TypeScript strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noImplicitOverride.
- Wire/persisted formats: snake_case, UUID v7, ISO 8601 UTC, schema_version integers.
- All product names/colors come from `@maman/config` — never hardcode.
- Model names come from configuration, not source.

## Commands

- `pnpm demo` — full local demo (Docker Compose + seed + all services)
- `pnpm lint / typecheck / test / build` — turbo across the workspace
- `pnpm test:rust`, `pnpm test:swift` — native suites
- `bash scripts/bootstrap-local-env.sh` — create .env with generated local secrets

## Process

- Work milestone by milestone; keep BUILD_STATUS.md current with evidence (no marketing language).
- After every milestone: format, typecheck, unit + integration tests, build. Fix before continuing.
- Never commit certificates, profiles, or secrets. `.env` is ignored.
