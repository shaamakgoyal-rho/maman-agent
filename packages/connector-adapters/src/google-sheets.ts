import {
  PermanentAdapterError,
  type CapabilityAdapter,
  type CapabilityContext,
} from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type CredentialProvider,
  type IdempotencyStore,
} from "./credentials.js";

/**
 * Thin real Google Sheets execution (read a range, update cells) — enough to
 * prove the registry is genuinely multi-provider. Same auth/refresh/fault
 * discipline as Salesforce; the token comes from the vault and is never
 * returned to a caller. No delete, no destructive scope (see providers.ts).
 */

const PROVIDER = "google_sheets";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export type GoogleSheetsAdapterConfig = {
  credentials: CredentialProvider;
  transport: HttpTransport;
  idempotency: IdempotencyStore;
};

export function googleSheetsCapabilities(
  config: GoogleSheetsAdapterConfig,
): Map<string, CapabilityAdapter> {
  async function authed(
    ctx: CapabilityContext,
    capability: string,
    build: (accessToken: string) => { method: "GET" | "PUT"; url: string; body?: unknown },
  ): Promise<HttpResponse> {
    let creds = await config.credentials.load({
      organization_id: ctx.organization_id,
      provider: PROVIDER,
    });
    if (!creds) throw new PermanentAdapterError(`${capability}: no linked Google Sheets connector`);
    const run = async (token: string): Promise<HttpResponse> => {
      const req = build(token);
      try {
        return await config.transport({
          method: req.method,
          url: req.url,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (e) {
        throwTransientNetwork(capability, e);
      }
    };
    let res = await run(creds.access_token);
    if (res.status === 401) {
      creds = await config.credentials.refresh({
        organization_id: ctx.organization_id,
        provider: PROVIDER,
      });
      res = await run(creds.access_token);
      if (res.status === 401)
        throw new PermanentAdapterError(`${capability}: unauthorized after refresh`);
    }
    if (res.status < 200 || res.status >= 300) {
      throwForStatus(capability, res.status, summarizeGoogleError(res.body));
    }
    return res;
  }

  const registry = new Map<string, CapabilityAdapter>();

  registry.set("google_sheets.read_range", {
    id: "google_sheets.read_range",
    read: async (inputs, ctx) => {
      const spreadsheetId = String(inputs["spreadsheet_id"] ?? "");
      const range = String(inputs["range"] ?? "");
      if (!spreadsheetId || !range) {
        throw new PermanentAdapterError(
          "google_sheets.read_range: spreadsheet_id and range required",
        );
      }
      const res = await authed(ctx, "google_sheets.read_range", (token) => ({
        method: "GET",
        url: `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        // token used only for the Bearer header inside authed()
        ...(token ? {} : {}),
      }));
      return (res.body as { values?: unknown[][] }).values ?? [];
    },
  });

  registry.set("google_sheets.write_range", {
    id: "google_sheets.write_range",
    write: async (inputs, _approvedDiff, ctx, idempotencyKey) => {
      const prior = await config.idempotency.get(idempotencyKey);
      if (prior !== undefined) return prior;
      const spreadsheetId = String(inputs["spreadsheet_id"] ?? "");
      const range = String(inputs["range"] ?? "");
      const values = inputs["values"] as unknown[][] | undefined;
      if (!spreadsheetId || !range || !values) {
        throw new PermanentAdapterError(
          "google_sheets.write_range: spreadsheet_id, range, values required",
        );
      }
      const res = await authed(ctx, "google_sheets.write_range", (token) => ({
        method: "PUT",
        url: `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(
          range,
        )}?valueInputOption=RAW`,
        body: { range, majorDimension: "ROWS", values },
        ...(token ? {} : {}),
      }));
      const updated = (res.body as { updatedCells?: number }).updatedCells ?? 0;
      const result = { applied: updated, idempotency_key: idempotencyKey };
      await config.idempotency.set(idempotencyKey, result);
      return result;
    },
  });

  return registry;
}

function summarizeGoogleError(body: unknown): string {
  if (body && typeof body === "object") {
    const e = body as { error?: { status?: string; message?: string } };
    if (e.error) return `${e.error.status ?? ""} ${e.error.message ?? ""}`.trim();
  }
  return "";
}
