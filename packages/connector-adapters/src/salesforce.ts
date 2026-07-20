import {
  normalizeDomain,
  type CapabilityAdapter,
  type CapabilityContext,
  type ProposedDiff,
} from "@maman/agent-runtime";
import type { CsvAccountRow, SfAccount } from "@maman/demo-fixtures";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type CredentialProvider,
  type IdempotencyStore,
} from "./credentials.js";
import { PermanentAdapterError } from "@maman/agent-runtime";

/**
 * Real Salesforce execution (read + field-update only — no delete, no send, no
 * payment; the catalog already excludes those). Access tokens are fetched from
 * the vault at run time and injected as Bearer headers; they are never returned
 * to any caller or written into outputs. On 401 the token is refreshed once via
 * the connector-auth refresh path and the request retried.
 */

export const SF_API_VERSION = "v60.0";

/**
 * Logical demo-model field -> Salesforce Account API field. `Name`, `Website`,
 * and `NumberOfEmployees` are standard; `owner` and `segment` map to text
 * fields whose API names are org-configurable (defaults below). We deliberately
 * treat `owner` as a text field rather than resolving/reassigning OwnerId — v1
 * never performs an ownership transfer.
 */
export type SalesforceFieldMap = {
  owner: string;
  employee_count: string;
  website: string;
  segment: string;
};

export const DEFAULT_SF_FIELD_MAP: SalesforceFieldMap = {
  owner: "Account_Owner_Name__c",
  employee_count: "NumberOfEmployees",
  website: "Website",
  segment: "Market_Segment__c",
};

type SalesforceRecord = Record<string, unknown> & { Id: string; Name: string };

export type SalesforceAdapterConfig = {
  credentials: CredentialProvider;
  transport: HttpTransport;
  idempotency: IdempotencyStore;
  fieldMap?: SalesforceFieldMap;
};

const PROVIDER = "salesforce";

function sfString(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function recordToAccount(r: SalesforceRecord, map: SalesforceFieldMap): SfAccount {
  const website = sfString(r[map.website]);
  return {
    id: r.Id,
    name: sfString(r.Name),
    website,
    domain: normalizeDomain(website),
    owner: sfString(r[map.owner]),
    employee_count: Number(r[map.employee_count] ?? 0),
    segment: sfString(r[map.segment]),
  };
}

/** Escapes a value for safe embedding inside a SOQL single-quoted literal. */
function soqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function salesforceCapabilities(
  config: SalesforceAdapterConfig,
): Map<string, CapabilityAdapter> {
  const map = config.fieldMap ?? DEFAULT_SF_FIELD_MAP;
  const selectFields = ["Id", "Name", map.website, map.employee_count, map.owner, map.segment];

  /**
   * Issues an authed request, refreshing the token once on 401 and retrying.
   * Non-2xx (other than the handled 401) is mapped to the fault taxonomy.
   */
  async function authed(
    ctx: CapabilityContext,
    capability: string,
    build: (creds: { access_token: string; instance_url: string }) => {
      method: "GET" | "PATCH";
      path: string;
      body?: unknown;
    },
  ): Promise<HttpResponse> {
    let creds = await config.credentials.load({
      organization_id: ctx.organization_id,
      provider: PROVIDER,
    });
    if (!creds) {
      throw new PermanentAdapterError(`${capability}: no linked Salesforce connector`);
    }
    const run = async (accessToken: string, instanceUrl: string): Promise<HttpResponse> => {
      const req = build({ access_token: accessToken, instance_url: instanceUrl });
      const url = `${instanceUrl.replace(/\/$/, "")}/services/data/${SF_API_VERSION}${req.path}`;
      try {
        return await config.transport({
          method: req.method,
          url,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (e) {
        throwTransientNetwork(capability, e);
      }
    };

    const instanceUrl = creds.instance_url;
    if (!instanceUrl) {
      throw new PermanentAdapterError(`${capability}: missing Salesforce instance_url`);
    }
    let res = await run(creds.access_token, instanceUrl);
    if (res.status === 401) {
      // Token expired/revoked → refresh once and retry.
      creds = await config.credentials.refresh({
        organization_id: ctx.organization_id,
        provider: PROVIDER,
      });
      const refreshedInstance = creds.instance_url ?? instanceUrl;
      res = await run(creds.access_token, refreshedInstance);
      if (res.status === 401) {
        throw new PermanentAdapterError(`${capability}: unauthorized after refresh`);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throwForStatus(capability, res.status, summarizeSfError(res.body));
    }
    return res;
  }

  const registry = new Map<string, CapabilityAdapter>();

  // Read: SOQL query for candidate Accounts by the input domains.
  registry.set("salesforce.query_records", {
    id: "salesforce.query_records",
    read: async (inputs, ctx) => {
      const keys = (inputs["keys"] as CsvAccountRow[]) ?? [];
      const domains = [...new Set(keys.map((k) => normalizeDomain(k.domain)).filter(Boolean))];
      if (domains.length === 0) return [];
      const where = domains.map((d) => `${map.website} LIKE '%${soqlLiteral(d)}%'`).join(" OR ");
      const soql = `SELECT ${selectFields.join(", ")} FROM Account WHERE ${where} LIMIT 2000`;
      const res = await authed(ctx, "salesforce.query_records", () => ({
        method: "GET",
        path: `/query?q=${encodeURIComponent(soql)}`,
      }));
      const records = ((res.body as { records?: SalesforceRecord[] }).records ?? []).map((r) =>
        recordToAccount(r, map),
      );
      return records;
    },
  });

  // Write: apply the approved field changes, one PATCH per record.
  registry.set("salesforce.update_fields", {
    id: "salesforce.update_fields",
    write: async (_inputs, approvedDiff: ProposedDiff, ctx, idempotencyKey) => {
      // Single-write: an already-applied key returns its prior result unchanged.
      const prior = await config.idempotency.get(idempotencyKey);
      if (prior !== undefined) return prior;

      // Group changes by account so each record is one PATCH.
      const byAccount = new Map<string, Record<string, unknown>>();
      for (const change of approvedDiff.changes) {
        const body = byAccount.get(change.account_id) ?? {};
        const apiField =
          change.field === "employee_count"
            ? map.employee_count
            : change.field === "website"
              ? map.website
              : change.field === "owner"
                ? map.owner
                : map.segment;
        body[apiField] =
          change.field === "employee_count" ? Number(change.new_value) : change.new_value;
        byAccount.set(change.account_id, body);
      }

      let applied = 0;
      for (const [accountId, body] of byAccount) {
        await authed(ctx, "salesforce.update_fields", () => ({
          method: "PATCH",
          path: `/sobjects/Account/${encodeURIComponent(accountId)}`,
          body,
        }));
        applied += approvedDiff.changes.filter((c) => c.account_id === accountId).length;
      }
      const result = { applied, idempotency_key: idempotencyKey };
      await config.idempotency.set(idempotencyKey, result);
      return result;
    },

    // Independent read-back: re-query the changed accounts and confirm values.
    verify: async (inputs, output, ctx) => {
      const proposal = inputs["proposal"] as ProposedDiff | undefined;
      const changes = proposal?.changes ?? [];
      if (changes.length === 0) return { verified: true, detail: "no changes to verify" };
      const ids = [...new Set(changes.map((c) => c.account_id))];
      const soql = `SELECT ${selectFields.join(", ")} FROM Account WHERE Id IN (${ids
        .map((id) => `'${soqlLiteral(id)}'`)
        .join(", ")})`;
      const res = await authed(ctx, "salesforce.update_fields.verify", () => ({
        method: "GET",
        path: `/query?q=${encodeURIComponent(soql)}`,
      }));
      const byId = new Map(
        ((res.body as { records?: SalesforceRecord[] }).records ?? [])
          .map((r) => recordToAccount(r, map))
          .map((a) => [a.id, a] as const),
      );
      let confirmed = 0;
      for (const change of changes) {
        const account = byId.get(change.account_id);
        if (account && sfString(account[change.field]) === change.new_value) confirmed++;
      }
      const applied = (output as { applied?: number }).applied ?? 0;
      const verified = confirmed === changes.length && applied === changes.length;
      return {
        verified,
        detail: `independent read confirmed ${confirmed}/${changes.length} field change(s)`,
      };
    },
  });

  return registry;
}

function summarizeSfError(body: unknown): string {
  if (Array.isArray(body) && body[0] && typeof body[0] === "object") {
    const first = body[0] as { errorCode?: string; message?: string };
    return `${first.errorCode ?? "error"} ${first.message ?? ""}`.trim();
  }
  if (body && typeof body === "object") {
    const e = body as { error?: string; error_description?: string };
    if (e.error) return `${e.error} ${e.error_description ?? ""}`.trim();
  }
  return "";
}
