# Privacy

> This document grows with the build and always matches actual repository behavior.

## What Maman can observe (only with your consent)

- Applications and websites **you allowlist** during onboarding — nothing before that.
- Semantic interaction events: app activated, window focused, element activated,
  navigation, record opened/updated, table read/exported, semantic copy/paste.
- Event _shape_, never content: roles, hashed identifiers, object types, counts, durations.

## What is never observed

- Keystrokes, typed text, raw field values, clipboard content.
- Passwords, secure fields, one-time codes, payment fields.
- Password managers, private/incognito windows, banking/health sites, system dialogs.
- Screens, except inside an explicit, indicator-visible, time-boxed Teach Mode session —
  and those frames are processed in memory and never written to disk or sent anywhere.

## Where data lives

- **Your device:** all workflow events and episodes, encrypted (AES-256-GCM) with a key
  in your macOS Keychain. You can inspect and delete everything.
- **Server:** only redacted pattern summaries you opt to sync, your agents, runs,
  approvals, audit metadata, and aggregate analytics. Never raw events or screenshots.

## What your company can see

- Aggregate adoption, cost, value, risk, and connector health.
- Aggregates are suppressed below a five-person cohort.
- No screen replay, no individual event history, no productivity rankings — these
  APIs do not exist.

## Your controls

Pause in one click. Allowlist/denylist apps and domains. Inspect "What Maman saw."
Exclude items from learning. Delete an event, an app's history, or everything.
Revoke the device. Disconnect connectors. Export your agent and ROI metadata.

## Retention

Local workflow events default to 30 days (configurable 1–90); episodes 90 days.
Deletions propagate to the sync outbox within one minute.
