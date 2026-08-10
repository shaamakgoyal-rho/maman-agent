# Maman

A desktop pet that notices repetitive work and builds safe helpers for you.

Maman observes only the applications and sites you allow, detects workflows you repeat,
and proposes transparent helper agents. Nothing writes to an external system without your
explicit, diff-bound approval, and every run reports honest verified time saved and cost.

## Download

**[Download Maman for macOS →](https://github.com/shaamakgoyal-rho/maman-agent/releases/latest/download/Maman.dmg)**
(universal — Apple Silicon and Intel, macOS 14+; [release notes](https://github.com/shaamakgoyal-rho/maman-agent/releases/latest))

Or visit the download page: **[getmaman.vercel.app](https://getmaman.vercel.app)**

Open the DMG, drag Maman into Applications, then **right-click Maman → Open** the first
time — this preview is not yet notarized, so macOS will say the developer cannot be
verified; right-click → Open is the one-time escape hatch. Grant Accessibility when
asked, click **Always Allow** on the keychain prompt, and choose which apps and sites
it may watch. See [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for how releases are cut.

> **Build status:** under active construction. See [BUILD_STATUS.md](BUILD_STATUS.md) for
> exactly what works today. This README's demo instructions grow as milestones land.

## One-command demo

```bash
pnpm install
pnpm demo
```

`pnpm demo` bootstraps `.env` with generated local-only secrets, starts local
infrastructure (PostgreSQL 17, Redis, Temporal, MinIO, Mailpit), and — as milestones
land — migrates, seeds, and starts the API, admin web, worker, and desktop pet.
No cloud credentials are required: model and connector calls run against deterministic
demo adapters.

## Prerequisites

- macOS 14+ for the desktop pet (API/web/worker also run on Linux)
- Node.js >= 24 and pnpm 9
- Docker Desktop (or compatible engine) with Compose v2
- Rust stable toolchain (desktop + native host)
- Xcode command-line tools (Swift observer)

## Architecture (summary)

Five processes with strict trust boundaries — see [ARCHITECTURE.md](ARCHITECTURE.md):

1. **Desktop app (Tauri 2)** — the pet, consent controls, local encrypted event store,
   local pattern analysis.
2. **macOS observer sidecar (Swift)** — semantic accessibility events only; no network code.
3. **Chrome extension (MV3)** — semantic events from allowlisted sites via authenticated
   native messaging.
4. **API + admin web (Fastify, Next.js)** — tenant-isolated (RLS) server with aggregate-only
   admin reporting.
5. **Temporal worker** — durable agent runs with shadow mode, diff-bound approvals, and
   idempotent writes.

## Privacy promise

- Observation defaults **off** and observes only what you allowlist.
- No keystroke logging, no raw screen storage, no manager screen replay, ever.
- Local workflow events are AES-256-GCM encrypted with a device key in your Keychain.
- Admins see aggregates (minimum cohort of five), never individual activity.
- You can pause in one click, inspect everything Maman saw, and delete it.

See [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [THREAT_MODEL.md](THREAT_MODEL.md).

## Commands

| Command                                                     | Purpose                                     |
| ----------------------------------------------------------- | ------------------------------------------- |
| `pnpm demo`                                                 | Full local demo                             |
| `pnpm demo:reset`                                           | Reset project-scoped demo state (confirmed) |
| `pnpm infra:up` / `pnpm infra:down`                         | Local infrastructure                        |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Quality gates                               |
| `pnpm test:rust` / `pnpm test:swift`                        | Native test suites                          |

## Known limitations

Tracked honestly in [BUILD_STATUS.md](BUILD_STATUS.md).
