# Security

> This document grows with the build and always matches actual repository behavior.

## Reporting

Report suspected vulnerabilities to the security contact in
`packages/config/src/product.ts` (`company.securityEmail`). Do not open public issues
for security reports.

## Security boundaries (implemented progressively)

- **Process isolation:** webview ⊄ Tauri core; page ⊄ extension worker; extension ⊄
  native host; every boundary is schema-validated.
- **Tenant isolation:** repository-level TenantContext plus PostgreSQL row-level
  security; cross-tenant access returns 404. _(lands at M1)_
- **Authentication:** WorkOS AuthKit in production; `AUTH_MODE=dev` is refused when
  `NODE_ENV=production` (enforced in `packages/config/src/env.ts`).
- **Secrets:** `.env` ignored; bootstrap generates local-only secrets; connector tokens
  envelope-encrypted server-side and never returned to clients. _(lands at M8)_
- **Approvals:** one-time hashed tokens bound to run, step, diff hash, user, and expiry;
  changed diffs invalidate approval. _(lands at M7)_
- **Idempotency:** idempotency record committed before any external write. _(lands at M7)_
- **Update signing:** dev builds state auto-update disabled; production requires a signed
  update key from CI secrets. _(lands at M10)_

## Secure development checklist

- [ ] No keystroke capture path anywhere in the codebase
- [ ] Structured log redaction for tokens, cookies, email bodies, record bodies
- [ ] Dependency audit + secret scan in CI
- [ ] LLM output parsed against strict schemas; prompt content delimited as untrusted
- [ ] No `dangerouslySetInnerHTML` for connector-derived content
