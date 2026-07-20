/**
 * Live Salesforce smoke test — gated behind real credentials, EXCLUDED from CI.
 *
 * Reads only by default (no writes). Provide a real access token + instance URL:
 *
 *   SF_SMOKE_ACCESS_TOKEN=... \
 *   SF_SMOKE_INSTANCE_URL=https://yourorg.my.salesforce.com \
 *   SF_SMOKE_DOMAIN=example.com \
 *   pnpm tsx scripts/smoke-salesforce.ts
 *
 * With SF_SMOKE_ALLOW_WRITE=1 it will additionally attempt a single no-op field
 * update on the first matched account (owner set to its current value) to
 * exercise the write + independent-read verification path safely.
 */
import {
  fetchTransport,
  MemoryIdempotencyStore,
  salesforceCapabilities,
  type CredentialProvider,
} from "@maman/connector-adapters";
import type { CapabilityContext, ProposedDiff } from "@maman/agent-runtime";

const accessToken = process.env["SF_SMOKE_ACCESS_TOKEN"];
const instanceUrl = process.env["SF_SMOKE_INSTANCE_URL"];
const domain = process.env["SF_SMOKE_DOMAIN"] ?? "example.com";

if (!accessToken || !instanceUrl) {
  console.log(
    "smoke-salesforce: SF_SMOKE_ACCESS_TOKEN / SF_SMOKE_INSTANCE_URL not set — skipping.",
  );
  process.exit(0);
}

const credentials: CredentialProvider = {
  load: async () => ({ access_token: accessToken, instance_url: instanceUrl }),
  refresh: async () => {
    throw new Error("refresh not supported in smoke mode (provide a fresh token)");
  },
};

const ctx: CapabilityContext = {
  run_id: "smoke",
  organization_id: "smoke-org",
  owner_user_id: "smoke-user",
  mode: "supervised",
};

async function main(): Promise<void> {
  const sf = salesforceCapabilities({
    credentials,
    transport: fetchTransport,
    idempotency: new MemoryIdempotencyStore(),
  });

  const accounts = (await sf.get("salesforce.query_records")!.read!(
    { keys: [{ domain }] },
    ctx,
  )) as Array<{ id: string; name: string; owner: string }>;
  console.log(`query_records: matched ${accounts.length} account(s) for domain "${domain}"`);
  for (const a of accounts.slice(0, 5)) console.log(`  - ${a.id} ${a.name}`);

  if (process.env["SF_SMOKE_ALLOW_WRITE"] === "1" && accounts[0]) {
    const a = accounts[0];
    const diff: ProposedDiff = {
      summary: {
        input_rows: 1,
        confident_matches: 1,
        ambiguous_skipped: 0,
        missing: 0,
        change_count: 1,
        accounts_affected: 1,
      },
      // No-op: set owner to its current value so nothing actually changes.
      changes: [
        {
          account_id: a.id,
          account_name: a.name,
          field: "owner",
          old_value: a.owner,
          new_value: a.owner,
        },
      ],
    };
    const result = await sf.get("salesforce.update_fields")!.write!({}, diff, ctx, `smoke-${a.id}`);
    console.log("update_fields:", JSON.stringify(result));
    const verification = await sf.get("salesforce.update_fields")!.verify!(
      { proposal: diff },
      result,
      ctx,
    );
    console.log("verify:", JSON.stringify(verification));
  }
  console.log("smoke-salesforce: OK");
}

main().catch((err) => {
  console.error("smoke-salesforce: FAILED", err);
  process.exit(1);
});
