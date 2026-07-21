# Go live: running Maman for a real trial

This is the exact path from a clean Mac to Maman running the full loop —
observe → suggest → shadow → supervised approval → measured-ROI receipt — first
against the deterministic demo stack, then (with four env edits + a Salesforce
Connected App) against real Anthropic and real Salesforce.

Nothing here weakens a safety invariant: shadow runs never write, writes are
bound to an approved step + diff hash, tokens live only in the server vault or
the device keychain, and cross-tenant reads return 404.

---

## 1. Prerequisites

| Requirement              | Version              | Notes                                                                   |
| ------------------------ | -------------------- | ----------------------------------------------------------------------- |
| macOS                    | 14 (Sonoma) or newer | Accessibility permission is macOS 14+                                   |
| Docker Desktop           | current              | Postgres, Redis, Temporal, MinIO run in Compose                         |
| Node                     | ≥ 24                 | `node -v`                                                               |
| pnpm                     | 9                    | `corepack enable && corepack prepare pnpm@9 --activate`                 |
| Rust                     | stable (via rustup)  | only needed to build the desktop app                                    |
| Xcode Command Line Tools | current              | `xcode-select --install` — needed for the Swift observer + native build |

Clone and install:

```bash
git clone <your-fork-or-remote> maman-agent
cd maman-agent
pnpm install
```

---

## 2. Demo mode — verify the whole loop with zero credentials

This is the sequence recorded in `BUILD_STATUS.md` (M18) and must pass before
you touch real credentials.

```bash
# 1. Create .env with generated local-only secrets (demo model + demo connectors).
bash scripts/bootstrap-local-env.sh

# 2. Bring the whole stack up: Docker infra, migrate, seed, API, worker, web.
pnpm demo
```

`pnpm demo` prints the local URLs when ready:

- Admin console — <http://localhost:3000>
- API — <http://localhost:4000> (health at `/health/ready`)
- Temporal UI — <http://localhost:8233>

Then start the desktop app (in a second terminal):

```bash
# macOS desktop app (Tauri):
pnpm --filter @maman/desktop tauri dev

# — or, on any platform, the web preview (local demo runs only, no server path):
pnpm --filter @maman/desktop dev   # open /index.html, /pet.html, /lab.html
```

In the desktop panel:

1. Complete onboarding (consent gate — confirm all three privacy statements).
2. **Optional:** on the last onboarding step, choose _Run helpers on the server_
   → **Enroll this device**. (Or do this later in **Settings → Connect to Maman
   server**.) Local-only mode works with no enrollment.
3. **Home → Run demo workflow** six times (or click through the demo sequence).
4. **Suggestions** → a reconciliation suggestion appears → **Create agent**.
5. **Agents** → **Run shadow**: a proposed diff appears, **nothing is written**.
6. **Run supervised**: it pauses for approval. **Approve & write once** → the
   write applies and verifies → the receipt shows measured ROI and cost.

When enrolled, steps 5–6 run on the **server** (durable Temporal workflow, the
proposed diff and receipt fetched from the API). When not enrolled, the same
steps run as a **local demo run** with identical safety semantics.

---

## 3. Go live — the four edits + a Salesforce Connected App

Real writes need exactly **four** `.env` edits and one external setup (a
Salesforce Connected App). Env validation fails fast if any pair is half-set.

Edit `.env`:

```dotenv
# [1] + [2] — real model
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# [3] + [4] — real connectors + Salesforce Connected App (all three together)
CONNECTOR_MODE=real
SALESFORCE_CLIENT_ID=<Consumer Key from the Connected App>
SALESFORCE_CLIENT_SECRET=<Consumer Secret>
SALESFORCE_REDIRECT_URI=http://localhost:4000/v1/connectors/salesforce/callback
```

**Salesforce Connected App** (Setup → App Manager → New Connected App):

- Enable OAuth settings.
- Callback URL: exactly `http://localhost:4000/v1/connectors/salesforce/callback`
  (must match `SALESFORCE_REDIRECT_URI` character-for-character).
- OAuth scopes: `api`, `refresh_token`.
- Copy the Consumer Key/Secret into the `.env` values above.

Restart the stack so the new env is loaded:

```bash
pnpm infra:down    # optional; keeps data if you skip it
pnpm demo          # re-reads .env; API + worker start in real mode
```

Then in the desktop panel: **Settings → Connectors → Salesforce → Connect**.
This opens the real Salesforce OAuth flow in your **system browser** (never an
embedded webview). The token is stored **envelope-encrypted in the server
vault** — it never returns to the app. Run a supervised reconciliation and
approve: the write goes through `realAdapterRegistry` against your Salesforce,
and the independent read-back verifies it.

The safety invariants are unchanged and still enforced: the vault token never
appears in any client response, step output, or receipt (proven by
`apps/worker` real-connector invariant tests).

---

## 4. Verify a real Salesforce write without wiring OAuth (optional smoke)

If you have a Salesforce access token but don't want to run the full OAuth
connect, the gated smoke script proves the adapter path end-to-end:

```bash
SF_SMOKE_ACCESS_TOKEN=<token> \
SF_SMOKE_INSTANCE_URL=https://yourorg.my.salesforce.com \
SF_SMOKE_ALLOW_WRITE=1 \
pnpm tsx scripts/smoke-salesforce.ts
```

Without `SF_SMOKE_*` set it no-ops (skips), so it is safe to leave in CI.

---

## 5. Troubleshooting

| Symptom                                                | Cause                                                                                         | Fix                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pet says **observer: PermissionRequired**              | macOS Accessibility not granted                                                               | Settings → Observation → _Grant Accessibility permission_, then toggle the app in System Settings → Privacy & Security → Accessibility. Maman never guesses — it stays paused until granted.                                                                         |
| **Enroll fails with 401**                              | API not running/seeded, or dev auth resolution failed                                         | Confirm `pnpm demo` is up and `curl "http://localhost:4000/v1/dev/resolve-org?workos_id=org_demo_acme_sales"` returns an org id. Re-run `pnpm db:seed` if empty.                                                                                                     |
| Salesforce connect returns **redirect_uri mismatch**   | Connected App callback ≠ `SALESFORCE_REDIRECT_URI`                                            | Make both exactly `http://localhost:4000/v1/connectors/salesforce/callback`.                                                                                                                                                                                         |
| Runs never leave _validating_ / **Temporal not ready** | Worker or Temporal not up                                                                     | Check `pnpm demo` logs (path printed at startup) for `worker_ready`; Temporal UI at <http://localhost:8233>. `docker compose ps` should show all services healthy.                                                                                                   |
| API refuses to start with an env error                 | A half-set pair (e.g. `MODEL_PROVIDER=anthropic` with no key, or a partial Salesforce triple) | The error names the exact variables. Set the whole pair/triple, or revert to `MODEL_PROVIDER=demo` / `CONNECTOR_MODE=demo`.                                                                                                                                          |
| `tauri dev` fails: `externalBin` sidecar missing       | Xcode CLT missing or the Swift binary not staged for the Tauri target triple                  | `xcode-select --install`, then build + stage the sidecar: `(cd native/macos-observer && swift build -c release)` and `cp native/macos-observer/.build/release/maman-observer apps/desktop/src-tauri/binaries/maman-observer-aarch64-apple-darwin`, then `tauri dev`. |
