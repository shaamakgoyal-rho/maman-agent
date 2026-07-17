# Data retention and deletion

Maman's default posture is to keep as little as possible off the device, and to
make deletion real.

## What lives where

| Data                                | Location                      | Leaves device?                   |
| ----------------------------------- | ----------------------------- | -------------------------------- |
| Raw workflow events                 | Encrypted SQLite (device)     | No — never in raw form           |
| Redacted, boundary-checked features | Encrypted sync outbox         | Yes — only after redaction gates |
| Raw screen pixels / typed input     | Not collected                 | N/A — never captured             |
| AgentSpecs, runs, receipts, audit   | Postgres (server)             | Server-side, tenant-isolated     |
| Connector tokens                    | Postgres (envelope-encrypted) | Never returned to any client     |

## Local device retention

- Every event payload column is AES-256-GCM encrypted with a per-install key held
  in the OS keychain; a unique nonce per record; AAD binds
  table + record + schema version + owner.
- Ingest is gated: paused, hard-denied, user-private, and non-allowlisted content
  never enter the store; a denied batch emits at most one identity-free
  `boundary_redacted` marker.
- Decrypt failures quarantine the record rather than surfacing plaintext.

## Deletion

- Users can delete a single event, everything for one app (looked up via a keyed
  HMAC of the app name so the store needs no plaintext app index), or all local
  data.
- Deletion writes tombstones that survive retention sweeps, so a deleted item
  cannot silently reappear from a later sync or restore.

## Server retention

- Audit events and execution receipts are append-only (mutation-forbidding
  triggers) and retained for the org's configured window (default 400 days). They
  are never edited — corrections are new events.
- Aggregate reporting suppresses any cohort below five people; there is no
  server endpoint that returns an individual's raw events, screen content, or a
  productivity ranking.
- Rotating `CONNECTOR_ENCRYPTION_MASTER_KEY` re-wraps data keys; old ciphertext
  is unreadable once the previous master key is retired.

## Configuration

Retention windows and deny lists are policy, written by a `security_admin` and
recorded as immutable policy versions with an audit event. Policy changes are
re-evaluated before every run.
