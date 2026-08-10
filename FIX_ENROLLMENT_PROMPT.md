# One-shot prompt: correct fix for the enrollment/setup failure

Paste everything below the line into `claude` (or your coding agent) at the repo root.

---

Read `CLAUDE.md` and `BUILD_STATUS.md` first; every CLAUDE.md rule is binding. Do not rework architecture, and do not weaken any safety invariant.

**Bug (M18 regression, root-caused):** device enrollment and the connectors setup screen fail because the webview makes direct HTTP calls to the API, which the app's own security posture forbids:

1. `apps/desktop/src/state/enrollment.ts` (`resolveDevIdentityOverHttp`) fetches `http://localhost:4000/v1/dev/resolve-org` and `/v1/dev/resolve-user` from the webview. The Tauri CSP (`apps/desktop/src-tauri/tauri.conf.json`, `connect-src 'self' ipc: http://ipc.localhost`) correctly refuses the connection, so `enroll()` throws before the (working) Rust `device_enroll` command is ever invoked.
2. `apps/desktop/src/panel/screens/Settings.tsx` fetches `http://localhost:4000/v1/connectors/...` from the webview — same CSP block, and the API registers no CORS (correctly: nothing browser-origin should call it).

The architectural rule these violate is already stated in the code: **all device→server HTTP originates in Rust** (`lib.rs`: "all HTTP originates here in Rust"). The fix is to finish enforcing that rule — NOT to loosen CSP and NOT to add CORS to the API. Do not add `@fastify/cors`. Do not touch `connect-src`.

## 1. Move dev-identity resolution behind a Tauri command

- Add a panel-only Tauri command `resolve_dev_identity` in `apps/desktop/src-tauri/src/lib.rs` following the exact conventions of `device_enroll` (`require_panel`, `sync::ReqwestTransport`, `api_base_url()`): it calls `GET /v1/dev/resolve-org?workos_id=...` and `GET /v1/dev/resolve-user?workos_id=...` on the API and returns `{ organization_id, user_id, role }`. Non-OK responses map to actionable errors ("Is the API running and seeded?" with the status code). Add the corresponding method(s) to `sync::SyncClient` with unit tests against the existing mock transport (success, org 404, user 404, network error).
- The demo WorkOS ids (`org_demo_acme_sales`, `user_demo_alex`) move to one shared constant location (Rust side or passed from the webview as plain identifiers — they are not secrets); no behavior change.
- In `enrollment.ts`, replace `resolveDevIdentityOverHttp` with an `invoke`-based implementation through `EnrollmentDeps.resolveDevIdentity` (the dependency-injection seam already exists — the store code itself should barely change). Update the enrollment unit tests; add one asserting that **no code path in the webview calls `fetch` with an absolute URL** to the API base.

## 2. Move the connectors screen off webview fetch

- Audit `apps/desktop/src` for every `fetch(` to an absolute `http://` URL (Settings.tsx connectors authorize/list/disconnect/test at minimum; also check Activity.tsx, recommendations.ts, events.ts — anything found earlier to reference `localhost:4000`). Replace each with a panel-only Tauri command that proxies through `SyncClient` using the same auth pattern the route requires (dev headers or device token — match what the API route expects; the OAuth authorize URL must still open in the **system browser** via the existing opener, never a webview).
- Unit tests for each new command against the mock transport.

## 3. Guardrails so this class of bug cannot return

- Add an ESLint rule (or a small custom lint via `no-restricted-syntax`) for `apps/desktop/src` that forbids `fetch(` / `XMLHttpRequest` / `axios` with non-relative URLs, with a comment pointing to the Rust-HTTP rule. The existing violations must be gone for lint to pass.
- Add a Rust test asserting the CSP string in `tauri.conf.json` does not contain `localhost:4000` (i.e., nobody "fixed" this by loosening CSP), alongside the existing config assertions if any.
- Extend the Playwright journey (`apps/e2e`) so the enroll step runs against `pnpm demo` services and fails if enrollment errors — it must catch exactly this regression.

## 4. Verification gate

- `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm test:rust`, `pnpm test:integration`, and the e2e suite — all green.
- Manually verify in `tauri dev` with `pnpm demo` up: Settings → Connect to Maman server → **Enroll this device** succeeds (device id + expiry shown, token only in keychain); **Sync now** reports counts; Settings → Connectors renders provider status and Connect opens the system browser.
- Record an M18.1 row in `BUILD_STATUS.md` with exact evidence (root cause, files changed, test counts, the manual verification). Commit as `M18.1: webview never talks HTTP — dev identity + connectors routed through Rust; CSP unchanged`.

Definition of done: enrollment and connector setup work in the desktop app with the CSP untouched and zero CORS on the API; a lint rule and a CSP test make the regression structurally impossible; all pre-existing safety tests pass unmodified.
