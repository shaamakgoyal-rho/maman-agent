/**
 * Suggestion surfacing policy (spec §12). Pure and fully testable.
 * A recommendation may surface only when every condition passes.
 */

export type SurfacingContext = {
  now: Date;
  observation_paused: boolean;
  private_context: boolean;
  fullscreen_or_presenting: boolean;
  screen_sharing: boolean;
  /** Suggestions surfaced so far this local calendar day. */
  surfaced_today: number;
  daily_budget: number;
  quiet_hours_start: string; // "HH:MM"
  quiet_hours_end: string; // "HH:MM"
  /** Pending approval or unacknowledged failure takes precedence. */
  attention_required: boolean;
  /** Seconds since last user interaction. */
  idle_seconds: number;
  /** True when the relevant workflow just completed. */
  just_completed_workflow: boolean;
  /** Recommendation-specific state. */
  snoozed_until: string | null;
};

export type SurfacingDecision = { allowed: true } | { allowed: false; reason: string };

export function inQuietHours(now: Date, start: string, end: string): boolean {
  const [sh = 0, sm = 0] = start.split(":").map(Number);
  const [eh = 0, em = 0] = end.split(":").map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false; // zero-length window disables quiet hours
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  // window crosses midnight (default 18:00 → 08:30)
  return minutes >= startMin || minutes < endMin;
}

export function canSurfaceSuggestion(ctx: SurfacingContext): SurfacingDecision {
  if (ctx.observation_paused) return { allowed: false, reason: "observation_paused" };
  if (ctx.private_context) return { allowed: false, reason: "private_context" };
  if (ctx.fullscreen_or_presenting) return { allowed: false, reason: "fullscreen_or_presenting" };
  if (ctx.screen_sharing) return { allowed: false, reason: "screen_sharing" };
  if (inQuietHours(ctx.now, ctx.quiet_hours_start, ctx.quiet_hours_end)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  if (ctx.surfaced_today >= ctx.daily_budget) return { allowed: false, reason: "budget_exhausted" };
  if (ctx.attention_required) return { allowed: false, reason: "attention_required" };
  if (ctx.snoozed_until && ctx.now.toISOString() < ctx.snoozed_until) {
    return { allowed: false, reason: "snoozed" };
  }
  if (ctx.idle_seconds < 15 && !ctx.just_completed_workflow) {
    return { allowed: false, reason: "user_active" };
  }
  return { allowed: true };
}

export type SnoozeOption = "1h" | "4h" | "today" | "1w";

export function snoozeUntil(option: SnoozeOption, now: Date): string {
  switch (option) {
    case "1h":
      return new Date(now.getTime() + 3_600_000).toISOString();
    case "4h":
      return new Date(now.getTime() + 4 * 3_600_000).toISOString();
    case "today": {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      tomorrow.setHours(8, 30, 0, 0);
      return tomorrow.toISOString();
    }
    case "1w":
      return new Date(now.getTime() + 7 * 86_400_000).toISOString();
  }
}
