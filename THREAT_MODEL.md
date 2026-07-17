# Threat model

> Living document; each mitigation links to the tests that verify it as milestones land.

## Assets

Local workflow events; connector tokens; approval tokens; AgentSpecs; audit chain;
device keys; organization policy; aggregate analytics.

## Actors

End user (member), team manager, org admin, security admin, billing admin, external
attacker, malicious web page, compromised webview, malicious insider, model provider.

## Enumerated threats and mitigations

| #   | Threat                                                      | Mitigation                                                                       | Verified by    |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------- |
| 1   | Compromised desktop webview calls privileged Tauri commands | Per-window Tauri capabilities; pet window has no connector/filesystem capability | M2/M10 tests   |
| 2   | Malicious web page forges extension events                  | Content-script origin checks; service-worker validation; native-host auth        | M4 tests       |
| 3   | Extension replays native messages                           | HMAC + nonce replay cache + 60s timestamp window                                 | M4 tests       |
| 4   | Prompt injection inside CRM/web content                     | Untrusted-data delimiting; LLM cannot alter policy/capabilities; strict schemas  | M6 tests       |
| 5   | Model generates unauthorized capability or secret           | Catalog-restricted IDs; secret-shaped literal rejection; static validation       | M6 tests       |
| 6   | Cross-tenant API access                                     | TenantContext + Postgres RLS; foreign IDs return 404                             | M1 tests       |
| 7   | Stolen connector refresh token                              | Envelope encryption; tokens never returned to clients; rotation                  | M8 tests       |
| 8   | Approval replay after diff changes                          | One-time hashed tokens bound to run/step/diff-hash/expiry                        | M7 tests       |
| 9   | Temporal retry causes duplicate external write              | Idempotency key persisted before write; unsafe writes never auto-retry           | M7 tests       |
| 10  | Admin attempts to access employee raw data                  | No such endpoint exists; authorization tests prove absence                       | M1/M9 tests    |
| 11  | Logs leak event content or tokens                           | Structured redaction; log-capture assertions in tests                            | M10 tests      |
| 12  | Malicious connector response causes stored XSS              | Escaped rendering; no dangerouslySetInnerHTML for connector content              | M9/M10 tests   |
| 13  | Local database theft                                        | AES-256-GCM payload encryption; key in Keychain, not on disk                     | M3 tests       |
| 14  | Update-channel compromise                                   | Signed artifacts; auto-update disabled without signed key                        | M10 docs/tests |
| 15  | DoS through event flooding                                  | Per-device/per-user rate limits; bounded outbox with degradation                 | M3/M10 tests   |

## Residual risks

Documented at M10 with honest severity; nothing is claimed as certified (no SOC 2 /
HIPAA / ISO 27001 claim is made anywhere).
