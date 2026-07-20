# Prompt: Take Maman from demo-complete to fully functional v1

Copy everything below this line into a fresh agent session in the repo root.

---

You are working in the `maman-agent` repository. Read `CLAUDE.md`, `ARCHITECTURE.md`, and `BUILD_STATUS.md` first — every rule in CLAUDE.md is binding and non-negotiable. M0–M10 are complete: contracts, tenant-isolated DB with RLS + audit chain, deterministic pattern/policy/ROI engines, agent compiler, Temporal durable runs, OAuth connector broker, admin console, pet renderer, Swift observer, and Chrome extension all exist and pass 453 TS unit + 65 integration + 43 Rust + 20 Swift tests.

Your job is the integration work that turns this demo-complete system into a functional shipped app. The architecture must not be reworked. The safety invariants (no keystroke/password/screen capture, LLM output untrusted, raw data never leaves device, cross-tenant 404, high-risk always human-approved, deterministic policy) must never be weakened — if a milestone below ever conflicts with them, the safety rule wins and you stop and flag it.

Work milestone by milestone, in order. After each milestone: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus `pnpm test:rust` / `pnpm test:swift` where native code changed. Update `BUILD_STATUS.md` with exact evidence (commands, test counts — no marketing language) before moving on. Commit per milestone with the milestone name in the message.

## M11 — Real Salesforce connector execution

The worker currently wires only `demoAdapterRegistry` (`apps/worker/src/activities.ts`); `CONNECTOR_MODE=real` exists only in `packages/config/src/env.ts`. Build the real execution path for Salesforce first — read + field-update capabilities only, no send/delete/payment (catalog already excludes them).

- Create `packages/connector-adapters` (new package, respecting lint-enforced boundaries: packages never import from apps). Implement a `SalesforceAdapter` conforming to the existing `CapabilityAdapter` interface in `packages/agent-runtime/src/adapters.ts`: SOQL reads, record field updates via the Salesforce REST API, using access tokens fetched at run time from the connector broker vault (server-side only — tokens never serialize into AgentSpec, logs, prompts, or client responses; the existing connector suite invariant "plaintext token never appears in any client response or ciphertext column" must keep passing).
- Token refresh on 401 via the existing `connector-auth` refresh path; structured errors mapped to the existing fault taxonomy (transient-retry / permanent-no-retry / rate-limit). Writes remain single-attempt with idempotency ledger; reads keep the 1s/5s/30s retry schedule.
- Wire an adapter registry selector in the worker: `CONNECTOR_MODE=demo` → demo registry (unchanged), `CONNECTOR_MODE=real` → real registry that falls back per-capability to demo when no live connector is linked for the org. Shadow runs must remain write-impossible by construction in both modes.
- Post-write verification: independent read-back comparing the diff hash the human approved, feeding the existing ROI `measured` provenance.
- Tests: unit tests with a mock Salesforce transport (injectable, like connector-auth's mock transport) covering auth injection, refresh, retry classes, idempotent single-write, verification mismatch; one Testcontainers integration test proving a supervised run in real mode retrieves a vault token and never leaks it. Add a live smoke script (`scripts/smoke-salesforce.ts`) gated behind env creds, excluded from CI.
- Then repeat the pattern thinly for Google Sheets (read range / update cells) so the registry proves multi-provider.

## M12 — Desktop ↔ API round-trip

The Tauri backend has no HTTP client; the encrypted sync outbox never uploads and agents/runs never reach the server. Connect the desktop to the cloud.

- Add `reqwest` (rustls, no system openssl) to `apps/desktop/src-tauri`. All device→server calls originate in Rust, not the webview, so tokens live in Keychain, never in JS.
- Device enrollment: pairing flow where the user signs into the API (WorkOS in real mode, dev auth locally) and the device receives a scoped device token signed with `DEVICE_TOKEN_SIGNING_SECRET`; store in Keychain; add API routes `POST /v1/devices/enroll` + rotation. Contracts in `packages/contracts` (snake_case, UUID v7, ISO 8601, schema_version).
- Outbox sync: drain the existing encrypted sync outbox to a new `POST /v1/sync/events` endpoint in batches — only redacted, identity-safe projections defined in contracts may leave the device (enforce with a schema test that rejects any raw-payload shape). Exponential backoff, offline tolerance, at-least-once with server-side dedupe on event id.
- Agent lifecycle round-trip: Create agent in the desktop panel → `POST /v1/agents` → compiled spec persisted server-side → shadow/supervised runs execute on the Temporal worker → desktop polls or subscribes for pending approvals → approval UI signals the workflow (approval bound to step + diff hash, as the run engine already enforces) → receipt renders in the pet summary.
- Tests: Rust unit tests for enrollment/token storage/outbox drain (mock server); API Testcontainers tests for enroll + sync endpoints under RLS; one Temporal integration test driving approve-from-device-token end to end.

## M13 — Observer sidecar actually runs

`apps/desktop/src-tauri/src/observer.rs` has only the restart policy; the Swift observer is never spawned or bundled.

- Bundle the Swift observer binary as a Tauri sidecar (`externalBin` in `tauri.conf.json`); build it in `pnpm build:desktop` via a script in `apps/desktop/scripts`.
- Spawn + supervise: launch on app start (only after consent gate passed and observation not paused), speak the existing JSONL protocol (hello/event/boundary/heartbeat/error + control) over stdio into the existing Rust ingest gate, apply the existing `RestartPolicy` (3 per 10 min then surface failure to UI), kill on pause/quit.
- Permissions UX: detect missing Accessibility permission and show the grant flow; never silently degrade — the pet state should honestly reflect "not observing".
- CI scan `scan-observer-no-network.sh` must keep passing; add a Rust test that the spawn path refuses to start when consent/pause state forbids it.

## M14 — Real model provider in the flow

`AnthropicModelProvider` exists but nothing instantiates it in the compile/naming paths.

- Wire the provider factory (honoring `MODEL_PROVIDER`) into the API-side compiler and semantic-naming call sites. Model names from config, never source. Demo mode stays the default and fully deterministic.
- All existing guarantees stay enforced by tests: strict Zod parsing of model output, hostile tool-id rejection, model drafts never receive write steps, untrusted-data delimiting, capability allowlist.
- Add per-run model cost capture into the existing receipt cost line; budget cap per compile with graceful fallback to the deterministic recipe path on failure/overrun.

## M15 — Distribution: signing, notarization, updates

- Tauri signing config: Developer ID identity, hardened runtime, entitlements (Accessibility usage description), notarization via `xcrun notarytool` in a `release-desktop.yml` GitHub Actions workflow (secrets from repo secrets; never commit certificates — CLAUDE.md rule).
- Tauri updater with signed manifests; releases as GitHub Releases artifacts.
- Chrome extension: production zip build + Web Store listing assets; move native-host install from manual script to an in-app Settings action that runs the existing install script logic with clear path printing.
- CI additions: desktop bundle build and extension build on every PR; integration test job (Testcontainers + Temporal) which currently doesn't run in CI.

## M16 — Hosted backend + onboarding

- Deploy API + worker as the existing production Dockerfiles to a persistent host (Fly.io or Railway — pick one, document in `docs/DEPLOYMENT.md`), Temporal Cloud namespace, Supabase Postgres already carries the schema. `AUTH_MODE=workos` with live credentials; the dev-auth-refused-in-production invariant must hold.
- Org onboarding: self-serve org creation + member invites through WorkOS organizations; new API routes + admin console screens. Seeding remains for demo only. Cohort-suppression (≥5) and cross-tenant-404 invariants apply to all new routes — extend the security integration suite to cover them.
- Secrets via the host's secret manager; OTel exporter pointed at a real backend.

## M17 — E2E journey suite + hardening

- Playwright suite for the full journey: onboarding consent → demo workflow observed → suggestion appears → create agent → shadow run → supervised run with diff approval → receipt with measured ROI → autonomy promotion gate (must require human + org policy, never confidence). Run headless in CI against `pnpm demo`.
- Finish the pending Capability Mesh items listed in BUILD_STATUS: worker receipt generation at run time, recipe/bindings templates, Browser Relay popup renaming, the 12-step end-to-end demo.
- Load test the API (k6 or artillery, documented targets), chaos test worker restarts mid-run (approval state must survive), and a final full-workspace verification recorded in BUILD_STATUS.

Definition of done: a signed, notarized Maman.app that a new user can download, enroll against the hosted API, grant observation consent, have a real repeated Salesforce workflow detected, approve a supervised run that updates real Salesforce records, and read an honest measured-ROI receipt — with every existing safety test still green.
