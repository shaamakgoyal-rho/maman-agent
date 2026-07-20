import { describe, expect, it } from "vitest";
import {
  syncBatchRequestSchema,
  syncEventProjectionSchema,
  SYNC_MAX_BATCH_SIZE,
} from "../src/sync.js";

const validProjection = {
  schema_version: 1,
  event_id: "018f0000-0000-7000-8000-000000000001",
  occurred_at: "2026-07-18T10:00:00.000Z",
  monotonic_ms: 1234,
  source: "macos_ax",
  app_category: "crm",
  event_type: "record_update",
  sensitivity: "internal",
  excluded_from_learning: false,
  semantic_type: "save_button",
  object_type: "account",
  duration_ms: 4200,
  item_count_bucket: "11_50",
} as const;

describe("sync event projection — identity-safe, redacted", () => {
  it("accepts the redacted projection", () => {
    expect(syncEventProjectionSchema.safeParse(validProjection).success).toBe(true);
  });

  it("REJECTS any raw-event field leaking through (strict shape)", () => {
    // Every one of these would carry identity or raw content off the device.
    const rawFields: Record<string, unknown>[] = [
      { app: { display_name: "Salesforce", domain: "acme.my.salesforce.com" } },
      { display_name: "Salesforce" },
      { domain: "acme.example.com" },
      { url: "https://acme.my.salesforce.com/001" },
      { payload: { foo: "bar" } },
      { value: "secret text the user typed" },
      { text: "keystrokes" },
      { title: "Account — Northwind Traders" },
      { keystrokes: ["a", "b"] },
      { screenshot: "data:image/png;base64,..." },
    ];
    for (const extra of rawFields) {
      const result = syncEventProjectionSchema.safeParse({ ...validProjection, ...extra });
      expect(result.success, `must reject field ${Object.keys(extra)[0]}`).toBe(false);
    }
  });

  it("requires event_id to be a UUID and occurred_at ISO 8601", () => {
    expect(
      syncEventProjectionSchema.safeParse({ ...validProjection, event_id: "nope" }).success,
    ).toBe(false);
    expect(
      syncEventProjectionSchema.safeParse({ ...validProjection, occurred_at: "yesterday" }).success,
    ).toBe(false);
  });

  it("caps a sync batch at the maximum size", () => {
    const one = syncBatchRequestSchema.safeParse({ schema_version: 1, events: [validProjection] });
    expect(one.success).toBe(true);
    const tooMany = syncBatchRequestSchema.safeParse({
      schema_version: 1,
      events: Array.from({ length: SYNC_MAX_BATCH_SIZE + 1 }, (_, i) => ({
        ...validProjection,
        event_id: `018f0000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      })),
    });
    expect(tooMany.success).toBe(false);
  });
});
