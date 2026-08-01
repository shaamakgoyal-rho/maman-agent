# Live demo: detect a real workflow, suggest, execute — same day

This is the script for demoing Maman against **your own live activity** (not the
seeded fixture): you repeat a CRM workflow a few times in Chrome, Maman detects
it live, proves it against your own runs, suggests a helper, and executes it
with a shadow run, an approval-gated write, and a receipt.

The seeded 23-run arc (`Home → Seed demo history`) remains the richest story
(21 tested / 19 matched with named divergences). The live arc below trades that
depth for authenticity: every number comes from what you just did.

## What "live" means honestly

- Detection is 100% live: typed events from your allowlisted browser domain
  flow through the real gate → redact → encrypt → segment → cluster → verify
  pipeline. Nothing is staged.
- Execution runs against the **demo Salesforce world** unless you configure
  `CONNECTOR_MODE=real` + Salesforce Connected App credentials (see
  `docs/GO_LIVE.md`). The demo world persists for the session, so an approved
  write visibly sticks: a second shadow run finds nothing left to change.
- The **Live demo preset** lowers only volume bars (repeats, separate days,
  minutes saved, proof-run count) and enables back-to-back repetition
  splitting. The consistency, feasibility, and risk bars cannot be loosened —
  the settings schema and the engine both refuse. A visible banner shows when
  demo tuning is active, and the Forming view always displays the effective
  bars.

## Prerequisites

- The desktop app running (`pnpm --filter @maman/desktop tauri dev`, or the
  signed release build) with onboarding consent completed and observation ON.
- The Chrome extension loaded and paired (Settings → pairing token), with your
  demo domain enabled in the extension.
- A CRM web domain to click around in. The Rust categorizer must recognize it
  as CRM: `salesforce.com`, `force.com`, `lightning.force.com` (a free
  Salesforce Developer Edition org is ideal), or HubSpot. The domain must be in
  Privacy → Allowed sites.
- Not required: the Maman server, Docker, or any credentials — the local
  executor covers the whole arc.

## The script (~5 minutes)

1. **Settings → Detection tuning → "Live demo preset".** Point out the amber
   "demo tuning active" banner and that risk/feasibility bars are not in the
   list — they can't be lowered.
2. **Do your workflow 4 times in Chrome** on the allowlisted CRM domain.
   A good shape: open a record → search an account → edit two fields and
   commit each (press Enter / Tab out; commits are what the relay records —
   field _names_ only, never the values you type). Do the reps back-to-back;
   the repetition splitter counts each pass. Keep each rep to roughly 30–90
   seconds and do the steps in the same order.
3. **Open the panel → Suggestions** (allow up to a minute — the engine re-runs
   every 60s). Narrate the funnel: the pattern appears under **Forming** with
   an honest per-gate checklist ("Seen 2 of 3 times…"), then becomes a card
   once it clears every bar _and_ replay-verifies against your own runs:
   "I tested it against your last 4 runs and matched 4."
4. **Try it** → the draft agent compiles from the pattern's own derived intent
   (e.g. `update_account_records`) into the deterministic read → match →
   propose → approved-write → report plan. Open the Agents tab and show the
   plain-language plan.
5. **Run shadow**: full read path, a real proposed diff, zero writes — the
   receipt says so.
6. **Run supervised**: it pauses at the approval gate with the exact diff.
   Approve → the write applies → receipt with measured ROI and the autonomy
   meter ticking 1/5.
7. **Run shadow again**: the world persisted, so the diff is now empty or
   smaller — the work is genuinely done, not reset per run.
8. Afterwards: **Settings → Detection tuning → "Reset to production"**.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing under Forming after 4 reps               | Domain not allowlisted (Privacy → Allowed sites) or not enabled in the extension popup; observation paused; reps merged — verify "Split back-to-back repetitions" is on (the preset sets it). |
| Forming stuck on "Seen enough times"             | Reps varied too much (different step order/pages) or a rep had fewer than 3 recorded events — keep reps identical and commit at least two fields.                                             |
| Forming stuck on "Safe steps a helper can do"    | The domain categorized as generic "browser", not CRM — use a salesforce.com / force.com / HubSpot domain.                                                                                     |
| Card appears but "Try it" reports it can't draft | The pattern's intent has no deterministic recipe (non-CRM shape). Expected honesty: only CRM update/reconcile shapes compile today.                                                           |
| Pet never waves                                  | Quiet hours (default 18:00–08:30) or daily budget gate the proactive wave only — the card is still in the panel.                                                                              |

## Same-day math under the preset

With the preset (repeats ≥ 3, days ≥ 1, ≥ 3 min/wk projected, proof runs ≥ 3,
90s run boundary, restart splitting): 4 identical reps in one sitting segment
into 4 episodes, cluster at similarity 1.0, clear eligibility, and
replay-verify 4/4. This exact arc is pinned by
`apps/desktop/test/live-arc.test.ts`, including the compile → shadow →
supervised → approve → receipt tail and the persisted-world proof. Under
production bars the same activity stays visibly in **Forming** — the test
asserts that too.
