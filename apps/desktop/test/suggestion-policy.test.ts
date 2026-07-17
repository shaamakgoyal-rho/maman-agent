import { describe, expect, it } from "vitest";
import {
  canSurfaceSuggestion,
  inQuietHours,
  snoozeUntil,
  type SurfacingContext,
} from "../src/lib/suggestion-policy.js";

function ctx(overrides: Partial<SurfacingContext> = {}): SurfacingContext {
  return {
    now: new Date("2026-07-17T12:00:00"), // local noon
    observation_paused: false,
    private_context: false,
    fullscreen_or_presenting: false,
    screen_sharing: false,
    surfaced_today: 0,
    daily_budget: 2,
    quiet_hours_start: "18:00",
    quiet_hours_end: "08:30",
    attention_required: false,
    idle_seconds: 60,
    just_completed_workflow: false,
    snoozed_until: null,
    ...overrides,
  };
}

describe("quiet hours", () => {
  it("default window crosses midnight (18:00 → 08:30)", () => {
    expect(inQuietHours(new Date("2026-07-17T19:00:00"), "18:00", "08:30")).toBe(true);
    expect(inQuietHours(new Date("2026-07-17T02:00:00"), "18:00", "08:30")).toBe(true);
    expect(inQuietHours(new Date("2026-07-17T08:29:00"), "18:00", "08:30")).toBe(true);
    expect(inQuietHours(new Date("2026-07-17T08:30:00"), "18:00", "08:30")).toBe(false);
    expect(inQuietHours(new Date("2026-07-17T12:00:00"), "18:00", "08:30")).toBe(false);
    expect(inQuietHours(new Date("2026-07-17T17:59:00"), "18:00", "08:30")).toBe(false);
  });

  it("same-day windows work too", () => {
    expect(inQuietHours(new Date("2026-07-17T13:00:00"), "12:00", "14:00")).toBe(true);
    expect(inQuietHours(new Date("2026-07-17T15:00:00"), "12:00", "14:00")).toBe(false);
  });
});

describe("surfacing policy (spec §12)", () => {
  it("allows in the happy path", () => {
    expect(canSurfaceSuggestion(ctx())).toEqual({ allowed: true });
  });

  it("blocks while paused / private / presenting / sharing", () => {
    expect(canSurfaceSuggestion(ctx({ observation_paused: true }))).toMatchObject({
      reason: "observation_paused",
    });
    expect(canSurfaceSuggestion(ctx({ private_context: true }))).toMatchObject({
      reason: "private_context",
    });
    expect(canSurfaceSuggestion(ctx({ fullscreen_or_presenting: true }))).toMatchObject({
      reason: "fullscreen_or_presenting",
    });
    expect(canSurfaceSuggestion(ctx({ screen_sharing: true }))).toMatchObject({
      reason: "screen_sharing",
    });
  });

  it("enforces the daily budget (default two)", () => {
    expect(canSurfaceSuggestion(ctx({ surfaced_today: 1 }))).toEqual({ allowed: true });
    expect(canSurfaceSuggestion(ctx({ surfaced_today: 2 }))).toMatchObject({
      reason: "budget_exhausted",
    });
  });

  it("blocks during quiet hours", () => {
    expect(canSurfaceSuggestion(ctx({ now: new Date("2026-07-17T20:00:00") }))).toMatchObject({
      reason: "quiet_hours",
    });
  });

  it("attention (approval/failure) outranks suggestions", () => {
    expect(canSurfaceSuggestion(ctx({ attention_required: true }))).toMatchObject({
      reason: "attention_required",
    });
  });

  it("respects snooze", () => {
    expect(canSurfaceSuggestion(ctx({ snoozed_until: "2026-07-18T00:00:00.000Z" }))).toMatchObject({
      reason: "snoozed",
    });
    expect(canSurfaceSuggestion(ctx({ snoozed_until: "2026-07-17T00:00:00.000Z" }))).toEqual({
      allowed: true,
    });
  });

  it("waits for user idleness unless the workflow just completed", () => {
    expect(canSurfaceSuggestion(ctx({ idle_seconds: 5 }))).toMatchObject({
      reason: "user_active",
    });
    expect(canSurfaceSuggestion(ctx({ idle_seconds: 5, just_completed_workflow: true }))).toEqual({
      allowed: true,
    });
  });
});

describe("snooze options", () => {
  const now = new Date("2026-07-17T12:00:00.000Z");

  it("1h / 4h / 1w offsets", () => {
    expect(snoozeUntil("1h", now)).toBe("2026-07-17T13:00:00.000Z");
    expect(snoozeUntil("4h", now)).toBe("2026-07-17T16:00:00.000Z");
    expect(snoozeUntil("1w", now)).toBe("2026-07-24T12:00:00.000Z");
  });

  it("'today' snoozes until tomorrow morning", () => {
    const until = snoozeUntil("today", now);
    expect(until > now.toISOString()).toBe(true);
    expect(new Date(until).getHours()).toBe(8);
  });
});
