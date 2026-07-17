import { describe, expect, it } from "vitest";
import {
  containsForbiddenEventField,
  uuidv7,
  workflowEventSchema,
  type WorkflowEvent,
} from "../src/index.js";

function validEvent(): WorkflowEvent {
  return {
    schema_version: 1,
    event_id: uuidv7(),
    device_id: uuidv7(),
    user_id: uuidv7(),
    organization_id: uuidv7(),
    occurred_at: "2026-07-17T18:00:00.000Z",
    monotonic_ms: 1000,
    source: "demo",
    app: { display_name: "Salesforce", domain: "salesforce.com" },
    event_type: "record_opened",
    target: { role: "row", semantic_type: "account" },
    context: { object_type: "account", record_id_hash: "abc123" },
    duration_ms: 250,
    sensitivity: "internal",
    redaction: { applied: false, reasons: [] },
  };
}

describe("workflowEventSchema", () => {
  it("accepts a valid semantic event", () => {
    expect(workflowEventSchema.parse(validEvent())).toBeTruthy();
  });

  it("rejects unknown top-level fields", () => {
    const evt = { ...validEvent(), raw_text: "user typed this" };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });

  it("rejects unknown fields nested in target", () => {
    const evt = validEvent();
    const bad = { ...evt, target: { ...evt.target, value: "secret content" } };
    expect(workflowEventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown fields nested in context", () => {
    const evt = validEvent();
    const bad = { ...evt, context: { ...evt.context, email_body: "hello" } };
    expect(workflowEventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-UTC timestamp", () => {
    const evt = { ...validEvent(), occurred_at: "2026-07-17T18:00:00+02:00" };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });

  it("rejects an unknown event_type", () => {
    const evt = { ...validEvent(), event_type: "keystroke" };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });

  it("rejects an unknown source", () => {
    const evt = { ...validEvent(), source: "screen_recording" };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });

  it("rejects negative monotonic_ms", () => {
    const evt = { ...validEvent(), monotonic_ms: -1 };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });

  it("accepts a boundary_redacted event with reasons", () => {
    const evt: WorkflowEvent = {
      ...validEvent(),
      event_type: "boundary_redacted",
      sensitivity: "restricted",
      redaction: { applied: true, reasons: ["denied_application"] },
    };
    expect(workflowEventSchema.parse(evt)).toBeTruthy();
  });

  it("rejects an invalid sensitivity value", () => {
    const evt = { ...validEvent(), sensitivity: "top_secret" };
    expect(workflowEventSchema.safeParse(evt).success).toBe(false);
  });
});

describe("containsForbiddenEventField", () => {
  it("detects a forbidden field at the top level", () => {
    expect(containsForbiddenEventField({ value: "typed text" })).toBe("value");
  });

  it("detects a forbidden field nested deeply", () => {
    expect(containsForbiddenEventField({ context: { extra: { password: "x" } } })).toBe("password");
  });

  it("detects forbidden fields case-insensitively", () => {
    expect(containsForbiddenEventField({ Screenshot: "bytes" })).toBe("Screenshot");
  });

  it("returns null for a clean payload", () => {
    expect(containsForbiddenEventField(validEvent())).toBeNull();
  });

  it("detects clipboard and keystroke fields", () => {
    expect(containsForbiddenEventField({ clipboard: "raw" })).toBe("clipboard");
    expect(containsForbiddenEventField({ nested: { keystrokes: [1, 2] } })).toBe("keystrokes");
  });
});
