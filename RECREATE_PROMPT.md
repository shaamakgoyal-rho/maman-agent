# Recreate Existing Project Exactly

> Recovered from chat on 2026-08-05, not pasted from an original file — Part 1 is the
> prompt as given. Part 2 was added afterwards because Part 1 alone does **not**
> produce an exact duplicate: it states the goal without giving the recreator
> anything to check itself against. Part 2 supplies the invariants, the acceptance
> gate, and the specific mistakes that a well-meaning recreator makes.
>
> **Read this first:** if you literally want the same bytes, do not use this prompt.
> Use `git clone` (or `rsync -a`, which also carries uncommitted work). A
> prompt-driven rebuild cannot be byte-identical, so "exact" below is defined as
> _verifiable equivalence_ — same file set, same public APIs, same invariants, same
> gate passing with the same test counts.

---

## Part 1 — the prompt as given

You are an expert software architect and reverse engineer.
Your task is to recreate this project as faithfully as possible.

### Objective

Analyze the ENTIRE codebase before making any changes.
Treat the existing project as the source of truth.
The goal is NOT to improve, simplify, modernize, or redesign anything.
The goal is to reproduce the project so accurately that another developer could not
distinguish the recreated version from the original except for generated IDs or
secrets.

### Analysis Phase

Before writing any code:

1. Read every file.
2. Understand the architecture.
3. Map every dependency.
4. Document:
   - folder structure
   - technology stack
   - build system
   - coding conventions
   - naming conventions
   - component hierarchy
   - API routes
   - database schema
   - state management
   - authentication
   - environment variables
   - third-party services
   - deployment configuration
   - testing strategy
   - scripts
   - configuration files
   - hidden implementation patterns
   - reusable utilities
   - styling system
   - design system
   - animations
   - error handling
   - logging
   - caching
   - performance optimizations

Do not skip any file.

### Behavioral Requirements

Replicate:

- architecture
- folder layout
- filenames
- naming conventions
- coding style
- formatting
- comments
- interfaces
- function signatures
- public APIs
- component composition
- styling
- UI behavior
- animations
- routing
- business logic
- validation
- error messages
- loading states
- edge cases
- build configuration

Maintain identical behavior whenever possible.

### Forbidden

Do NOT:

- refactor
- optimize
- modernize
- rewrite using different patterns
- replace libraries
- simplify code
- remove duplication
- introduce your own architecture
- rename files
- rename functions
- reorganize folders
- change UX
- change styling
- change APIs

Unless the original project contains an obvious bug that prevents execution.

### Missing Information

If something cannot be inferred:

- infer it from surrounding code
- only ask questions if absolutely necessary

### Output

Produce:

1. A recreation plan.
2. The complete recreated project.
3. Ensure every file required for the project exists.
4. Verify imports.
5. Verify builds.
6. Verify dependencies.
7. Verify runtime behavior.

Before finishing, compare the recreated project against the analyzed project and
ensure:

- equivalent architecture
- equivalent functionality
- equivalent UI
- equivalent developer experience
- equivalent folder structure

Continue iterating until no significant differences remain.

---

## Part 2 — what makes the duplicate actually exact

### The acceptance gate (this is the definition of done, not a suggestion)

A recreation is complete when every one of these passes in the recreated tree. Run
them all; do not report success on a subset.

```bash
pnpm install --frozen-lockfile   # lockfile must satisfy the manifests unchanged
pnpm lint                        # eslint across the workspace
pnpm format:check                # SEPARATE from lint — prettier --check .
pnpm typecheck                   # tsc --noEmit, strict everywhere
pnpm test                        # expect: 21 successful, 21 total
pnpm build                       # turbo build across the workspace
pnpm packs:check                 # YAML packs match committed JSON
pnpm packs:conformance:check     # classifier fixture is current (12 cases)
pnpm packs:date-conformance:check # date fixture is current (35 cases)
bash scripts/test-rust.sh        # expect: 117 passed (desktop lib), 10 passed (browser-host)
bash scripts/test-swift.sh       # expect: ALL CHECKS PASSED
pnpm --filter @maman/e2e test:e2e # expect: 2 passed
```

`pnpm lint` and `pnpm format:check` are different scripts. Passing the first tells
you nothing about the second, and CI runs both.

Structural equality check against the original:

```bash
diff <(git -C original ls-files -s | sort) <(git -C recreated ls-files -s | sort)
```

Identical output means identical tracked content (blob hashes, not names). At the
time of writing: **513 tracked files**, HEAD `f04aa89`, Node 24+ (developed on
v26.3.1), pnpm 9.15.9.

### Shape of the workspace

Five apps, sixteen packages, two Rust crates, one Swift package.

| Path                     | Package                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`               | `@maman/api` — Fastify                                                                                                                                                                                                            |
| `apps/desktop`           | `@maman/desktop` — Tauri 2 + React                                                                                                                                                                                                |
| `apps/e2e`               | `@maman/e2e` — Playwright                                                                                                                                                                                                         |
| `apps/web`               | `@maman/web` — Next.js admin                                                                                                                                                                                                      |
| `apps/worker`            | `@maman/worker` — Temporal                                                                                                                                                                                                        |
| `apps/site`              | download page (static HTML, no package.json)                                                                                                                                                                                      |
| `packages/`              | agent-runtime, capability-catalog, capability-router, config, connector-adapters, connector-auth, contracts, db, demo-fixtures, domain-packs, model-provider, pattern-engine, policy-engine, roi-engine, tsconfig, workflow-graph |
| `apps/desktop/src-tauri` | Rust crate `maman-desktop`                                                                                                                                                                                                        |
| `native/browser-host`    | Rust crate `maman-browser-host`                                                                                                                                                                                                   |
| `native/macos-observer`  | Swift package (zero dependencies, **no network code** — CI greps for it)                                                                                                                                                          |

Internal packages export TypeScript source directly
(`"exports": { ".": "./src/index.ts" }`); apps bundle themselves. Packages must not
import from apps — this is lint-enforced. `policy-engine` must never call an LLM.

### Invariants that are not stylistic and must survive verbatim

These are the reason the codebase looks the way it does. A recreator who "cleans
these up" has produced a different product, not a duplicate.

1. **No keystrokes, screenshots, passwords, payment fields, or private-browsing
   content are ever captured.** Not a setting — a property of the observer.
2. **Raw pixels never cross the device boundary; raw typed input is never
   collected.** Label text is inspected only inside the observer process and hashed
   before storage.
3. **LLM output is untrusted data.** Parse with strict Zod, policy-check, reject
   safely. The model may never change eligibility, risk, permissions, or value.
4. **Policy may only restrict.** `applyPackPolicy` returns a ceiling equal or
   stricter via `lowerCeiling`; `requires_human` / `always_gate` are one-way
   latches. There is a 4×4 matrix test asserting the result is at least as strict as
   both inputs. No code path grants autonomy or clears an approval.
5. **Value matchers fail CLOSED.** `exceedsThreshold` is the single comparison
   point; unreadable _or_ low-confidence extraction counts as over the limit.
6. **Date extraction fails SILENT** — the opposite direction, deliberately. A date
   decides _when_ to offer help, so ambiguity means say nothing: `03/04/2026` returns
   confidence 0.35, below the 0.6 floor. `usableDate` is the only gate.
7. **Proactivity is restrict-only.** The generic surfacing gate runs first and its
   reason is returned verbatim; `pre_stage.mode` applies through `lowerCeiling` and
   can never raise a ceiling.
8. **Quiet periods queue, they never drop.** A withheld card reports its release
   date.
9. **Copy never fabricates evidence.** `renderCopy` refuses and names missing
   variables rather than guessing; replay evidence is only forwarded once it clears
   `verify_min_runs`, because a 2/2 score is noise dressed as proof.
10. **Cross-tenant resources return 404, never 403.** Every repository call requires
    `TenantContext`.
11. **Maman never observes itself.** The core adds its own bundle id to
    `private_apps`.
12. **Secret material never enters logs, analytics, prompts, or AgentSpec.**

### Drift contracts (the same logic exists in more than one language)

- `domain/classifier-conformance.json` (12 cases) — generated from the TypeScript
  classifier; asserted by the TS suite **and** by `domain.rs` in Rust.
- `domain/date-conformance.json` (35 cases) — generated from `extract-date.ts`;
  asserted by the TS suite, Swift XCTest, **and** the Swift assertion runner.

Both are generated, committed, and gated in CI. A missing fixture must **fail**, not
skip — silently skipping is how implementations diverge.

### Wire and storage conventions

- snake_case on anything persisted or on the wire; camelCase in TS internals.
- UUID v7 ids, ISO 8601 UTC timestamps ending in `Z` (offsets rejected),
  `schema_version` integers.
- Canonical pattern token: `source:app_category:event_type:target_role:semantic_type:object_type`,
  `-` for absent fields.
- `template_id` is `"<pack_domain>/<workflow_id>"`.
- All product names, colours, and model names come from `@maman/config` — never
  hardcoded. Model names come from configuration, not source.
- The local SQLite is **not** file-encrypted: plaintext columns are readable on disk,
  so any _value_ read off a user's record belongs in the encrypted payload, never a
  column.

### Traps that look like bugs and are not — do not "fix" these

Every one of these was a real defect found by running the thing, and the fix is
load-bearing:

- **Status bar position uses the monitor's work area, not the screen.** The Dock
  draws above ordinary always-on-top windows, so anchoring to the physical bottom
  edge makes the bar invisible.
- **`set_always_on_top(true)` is asserted explicitly**, not trusted from window
  config.
- **A restored manual bar position is clamped** onto the usable area, or a drag that
  ends at an edge leaves it unreachable.
- **A window `Moved` event only counts as a user drag if a pointer press happened on
  the bar.** The core moves that window itself; treating those as drags turned
  docking off on the first automatic placement.
- **`build-observer.sh UNIVERSAL=1` stages three sidecar filenames** (arm64, x86_64,
  fat). `tauri build --target universal-apple-darwin` validates the sidecar for each
  arch's own triple.
- **`dmg` is deliberately absent from `tauri.conf.json` bundle targets.** Tauri's
  `bundle_dmg.sh` drives Finder over AppleScript and fails _after_ the `.app`
  succeeds; adding it breaks every ordinary build. `scripts/build-release-dmg.sh`
  uses `hdiutil`.
- **The distributed app is signed with a self-signed identity, not left ad-hoc.**
  Ad-hoc yields "no usable signature" → macOS says "damaged", where right-click →
  Open fails. Signed yields "developer cannot be verified", where it works.
- **`domain/packs/*.json` are in `.prettierignore`** because prettier and the
  generator disagree.
- **Window moves are not workflow events.** They are handled and returned before the
  semantic-event path, so dragging a window never becomes an episode.

### Verification method (this part matters more than the code)

Unit tests passing is not evidence that a feature works. In this codebase, six
defects passed every test they had, and three of those were self-defeating — a UI
surface hidden behind the Dock, an app observing itself into a feedback loop, and a
listener that disabled the feature it had just enabled.

So, when recreating anything with a runtime surface:

- Instrument and read real values out of the running system. A ten-line diagnostic
  log settles in one read what three rounds of inference cannot.
- Never compare a measurement against a number you assumed. Measure both sides. Two
  values two pixels apart distinguish nothing.
- Check **content**, not status codes. An HTTP 200 can be a login page.
- State plainly what you could not verify, rather than implying you did.
