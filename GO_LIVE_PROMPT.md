# One-shot prompt: make Maman live

Paste everything below the line into `claude` (or your coding agent) at the repo root.

---

Read `CLAUDE.md`, `ARCHITECTURE.md`, and `BUILD_STATUS.md` before touching anything. Every rule in CLAUDE.md is binding. M0–M14 and M17 are complete and tested (device enrollment, sync, `POST /v1/agents`, Temporal run/approval routes, real Salesforce/Sheets adapters, Anthropic provider, observer sidecar spawn all exist server-side and in Rust). Do not rework architecture. Never weaken authz, tenant isolation, redaction, approval binding, or audit logging; LLM output stays untrusted; shadow runs stay write-impossible; secrets never enter logs, prompts, or AgentSpec.

Your task — **M18: wire the desktop UI to the existing server path and verify the product live end to end.** The gap today: `apps/desktop/src/lib/runs.ts` is a desktop-local executor hardcoded to `demoAdapterRegistry`/`DemoSalesforceWorld`/`DemoModelProvider`, and the Tauri commands `device_enroll` / `sync_now` (`apps/desktop/src-tauri/src/lib.rs` ~line 829) are invoked by no UI screen. The server can already do everything; the panel just never asks it to.

## 1. Enrollment + sync surfaced in the UI

- Add a "Connect to Maman server" card in `apps/desktop/src/panel/screens/Settings.tsx`: shows enrollment state (device id + token expiry only — the token itself never reaches the webview, as `device_enroll` already guarantees), an Enroll button invoking `device_enroll` (dev auth locally: org/user from the seeded demo org; `UserAuth::Workos` path untouched for later), a Sync now button invoking `sync_now`, and last-sync status.
- Auto-sync: start a periodic outbox drain (existing Rust sync client) once enrolled; surface failures honestly in the UI, never silently.
- Onboarding: after the consent gate, offer enrollment as an explicit optional step ("run helpers on the server") — local-only mode must keep working exactly as today.

## 2. Server-backed agent lifecycle from the panel

- When the device is enrolled, "Create agent" posts the accepted `PatternCandidate` to the existing `POST /v1/agents` (all HTTP from Rust, adding Tauri commands as needed — the webview never holds tokens; follow the `device_enroll` pattern). Compiled spec, versions, and lifecycle state render from server responses. Unenrolled devices keep the current local flow unchanged.
- "Run shadow" / "Run supervised" start runs via the existing API→Temporal routes (M12 part 3). Poll for pending approval; render the proposed diff exactly as the local flow does; Approve/Reject signal the workflow with the approval bound to step + diff hash (the run engine already enforces this — do not reimplement it). Receipt renders from the server `ExecutionReceipt`, including model cost.
- Keep `runs.ts` local executor as the explicit fallback labeled "local demo run" in the UI so the distinction is honest.
- Tests: unit tests for the new UI state machines; extend `apps/e2e/tests/journey.spec.ts` (or add `journey-server.spec.ts`) covering enroll → create agent on server → shadow → supervised → approve → receipt against `pnpm demo` services with demo adapters.

## 3. Live configuration

- Extend `scripts/bootstrap-local-env.sh` + `.env.example` comments so a real trial needs exactly four edits: `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `CONNECTOR_MODE=real`, and Salesforce Connected App creds (`SALESFORCE_CLIENT_ID/SECRET/REDIRECT_URI`). Env validation must fail with actionable messages if any pair is half-set (pattern already exists for the Anthropic key).
- Verify the Settings → Salesforce OAuth connect flow (M8 broker) works against `CONNECTOR_MODE=real` and that a supervised run then executes through `realAdapterRegistry` with the vault token — the existing invariant tests (token never in any client response, output, or receipt) must keep passing untouched.
- Write `docs/GO_LIVE.md`: prerequisites (macOS 14+, Docker Desktop, Node ≥24, pnpm 9, Rust, Xcode CLT), then the exact command sequence: `pnpm install` → `pnpm demo` → `pnpm --filter @maman/desktop build:observer` → `pnpm --filter @maman/desktop tauri dev` → onboarding → Accessibility grant → allowlist apps → enroll → connect Salesforce → repeat a Salesforce field-update workflow ~6× → accept suggestion → shadow → supervised → approve diff → receipt. Include a troubleshooting table (observer PermissionRequired, enrollment 401, OAuth redirect mismatch, Temporal not ready).

## 4. Verification gate (do not skip, do not soften)

- `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm test:rust`, `pnpm test:swift`, `pnpm test:integration` — all green.
- Run the full e2e suite headless against `pnpm demo`.
- Run the complete GO_LIVE.md sequence yourself with `CONNECTOR_MODE=demo` end to end; record every command and result in `BUILD_STATUS.md` under a new M18 row (exact evidence, no marketing language). Anything you could not verify live (e.g., real Salesforce writes without creds) must be listed explicitly as unverified with the smoke command (`scripts/smoke-salesforce.ts`) the user should run.
- Commit as `M18: desktop wired to server path — enrollment, server runs, live config`.

Definition of done: on a Mac with Docker running, a user pastes the GO_LIVE.md commands, grants Accessibility, allowlists their CRM app, repeats a field-update workflow six times, and Maman — through the server path — suggests a helper, shadow-runs it, shows an exact diff, writes only after approval, and reports a measured-ROI receipt. With the four `.env` edits and a Connected App, the same flow writes to real Salesforce. Every pre-existing safety test still passes unmodified.
