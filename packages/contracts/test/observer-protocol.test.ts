import { describe, expect, it } from "vitest";
import { observerControlSchema, observerMessageSchema, uuidv7 } from "../src/index.js";

describe("observer JSONL protocol", () => {
  it("accepts a hello message", () => {
    expect(
      observerMessageSchema.parse({
        type: "hello",
        observer_version: "0.1.0",
        capabilities: ["macos_ax"],
        pid: 1234,
      }),
    ).toBeTruthy();
  });

  it("boundary messages carry no application identity", () => {
    const parsed = observerMessageSchema.parse({
      type: "boundary",
      reason: "hard_denied",
      occurred_at: "2026-07-17T18:00:00.000Z",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/bundle|domain|display_name/);
    // and the schema rejects attempts to add identity
    expect(
      observerMessageSchema.safeParse({
        type: "boundary",
        reason: "hard_denied",
        occurred_at: "2026-07-17T18:00:00.000Z",
        bundle_id: "com.private.app",
      }).success,
    ).toBe(false);
  });

  it("event messages must contain a schema-valid WorkflowEvent", () => {
    expect(
      observerMessageSchema.safeParse({ type: "event", event: { event_type: "keystroke" } })
        .success,
    ).toBe(false);
    expect(
      observerMessageSchema.parse({
        type: "event",
        event: {
          schema_version: 1,
          event_id: uuidv7(),
          device_id: uuidv7(),
          user_id: uuidv7(),
          organization_id: uuidv7(),
          occurred_at: "2026-07-17T18:00:00.000Z",
          monotonic_ms: 1,
          source: "macos_ax",
          app: { display_name: "Salesforce" },
          event_type: "record_opened",
          target: {},
          context: {},
          sensitivity: "internal",
          redaction: { applied: false, reasons: [] },
        },
      }),
    ).toBeTruthy();
  });

  it("rejects unknown message types (no keystroke channel exists)", () => {
    expect(observerMessageSchema.safeParse({ type: "keystroke", keys: "abc" }).success).toBe(false);
  });

  it("teach mode control is time-boxed to fifteen minutes", () => {
    expect(
      observerControlSchema.parse({ type: "teach_mode_start", max_seconds: 300 }),
    ).toBeTruthy();
    expect(
      observerControlSchema.safeParse({ type: "teach_mode_start", max_seconds: 901 }).success,
    ).toBe(false);
  });
});
