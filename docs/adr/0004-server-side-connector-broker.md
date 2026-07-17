# ADR-0004: Server-side Connector Broker; tokens never reach client surfaces

- Status: accepted
- Date: 2026-07-17
- Deciders: principal engineer, security

## Context

Maman uses SaaS APIs (Salesforce, Google, Slack, HubSpot). OAuth tokens are
high-value secrets. The desktop app and the browser relay are client surfaces on
the employee's machine and cannot be trusted to hold long-lived credentials.

## Decision

A server-side Connector Broker owns the entire OAuth lifecycle. Authorization
uses the auth-code flow with PKCE and an HMAC-signed, short-lived state,
completed in the system browser (never an embedded webview). Tokens are exchanged
server-side and stored with envelope encryption (a per-credential data key
wrapped by a master key; AAD binds org + provider). No token — access or refresh
— is ever returned to the desktop or extension; every client-facing connector
response is a status view. Preference order for running a step is: API first;
never silently convert a failed API write into a browser write; browser writes
only under supervision; accessibility is discovery-only. Gmail is limited to
metadata and draft creation — no send, no delete — in v1.

## Consequences

- A compromised desktop or extension cannot exfiltrate SaaS credentials.
- The broker is a single, auditable place to enforce scopes, rotation, and
  disconnect-pauses-agents.
- Requires server infrastructure even for "just connect my Salesforce," which is
  the correct tradeoff.

## Alternatives considered

- **Tokens in the extension/desktop**: rejected outright — the stated
  non-negotiable; client surfaces are not a safe vault.
- **Implicit flow**: rejected — deprecated and returns tokens to the client.
