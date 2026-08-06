import { create } from "zustand";
import { TEACH_MODE_MAX_SECONDS, type WorkflowEvent } from "@maman/contracts";
import {
  appCategoryForBundle,
  eventFromReading,
  mergeReading,
  readingsFromObservation,
  startTeachSession,
  stopTeachSession,
  type TeachObservationEvent,
  type TeachReading,
  type TeachSessionState,
} from "../lib/teachMode.js";
import { ingestEvents } from "../lib/events.js";
import { useSettings } from "./settings.js";
import { sessionSpend, type FrameUsage, type SessionSpend } from "@maman/teach-mode";
import { visionSessionPrice } from "@maman/model-provider";

/**
 * Teach Mode session state for the panel.
 *
 * The pixels never reach this store. By the time anything arrives here the Rust
 * core has sent the frame, received the answer, and dropped the image — so what
 * this holds is metadata, the model's parsed claims, and the user's verdicts.
 *
 * NOTHING IS LEARNED UNTIL THE USER SAYS SO. Readings accumulate as `unreviewed`
 * and are written to the event store only by `saveKept`, only for readings the
 * user explicitly kept. Teach Mode is the one observation path whose readings can
 * be WRONG rather than merely incomplete, so the person who demonstrated the
 * workflow is the one who decides what it saw.
 */

/** Same identity the local run path uses; the observer defaults match these. */
const DEVICE = "00000000-0000-7000-8000-000000000000";
const OWNER = "00000000-0000-7000-8000-000000000001";
const ORG = "00000000-0000-7000-8000-000000000002";

/** How many refusal reasons to keep, newest first. */
const MAX_SKIPS = 6;

export type TeachSkipSummary = { reason: string; count: number };

type TeachStore = {
  session: TeachSessionState;
  maxSeconds: number;
  readings: TeachReading[];
  /** Why frames produced nothing, so "watching and learning nothing" is legible. */
  skips: TeachSkipSummary[];
  /** Frames that produced at least one reading. */
  framesRead: number;
  /**
   * What the session has ACTUALLY spent, from the token counts the API reported.
   *
   * Kept next to the estimate rather than instead of it: an estimate nobody checks
   * is a guess with a decimal point, and this is the check.
   */
  spend: SessionSpend;
  /** Per-frame usage, so spend is recomputed rather than accumulated by hand. */
  usages: FrameUsage[];
  error: string | null;
  saved: number | null;

  start: (scope: readonly string[], maxSeconds: number) => Promise<void>;
  stop: () => Promise<void>;
  /** Applied from the Rust core's `teach:status` channel. */
  applyStatus: (payload: { session_id?: string; state?: string; detail?: string | null }) => void;
  /** Applied from the Rust core's `teach:observation` channel. */
  applyObservation: (payload: TeachObservationEvent) => void;
  setVerdict: (id: string, verdict: "kept" | "discarded") => void;
  keepAll: () => void;
  discardAll: () => void;
  saveKept: () => Promise<void>;
  reset: () => void;
};

function noteSkip(skips: TeachSkipSummary[], reason: string): TeachSkipSummary[] {
  const at = skips.findIndex((s) => s.reason === reason);
  if (at !== -1) {
    return skips.map((s, i) => (i === at ? { ...s, count: s.count + 1 } : s));
  }
  return [{ reason, count: 1 }, ...skips].slice(0, MAX_SKIPS);
}

export const useTeach = create<TeachStore>((set, get) => ({
  session: { phase: "idle" },
  maxSeconds: 300,
  readings: [],
  skips: [],
  framesRead: 0,
  spend: { frames: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  usages: [],
  error: null,
  saved: null,

  start: async (scope, maxSeconds) => {
    const bounded = Math.max(1, Math.min(maxSeconds, TEACH_MODE_MAX_SECONDS));
    set({
      session: { phase: "starting", scope: [...scope] },
      maxSeconds: bounded,
      readings: [],
      skips: [],
      framesRead: 0,
      spend: { frames: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      usages: [],
      error: null,
      saved: null,
    });
    try {
      // The session id comes back from Rust, which minted it — the panel does not
      // choose it, so a session cannot be faked from the webview.
      const sessionId = await startTeachSession(scope, bounded);
      set({
        session: {
          phase: "recording",
          sessionId,
          scope: [...scope],
          startedAtMs: Date.now(),
        },
      });
    } catch (e) {
      // The refusal text from Rust is shown verbatim: "Teach Mode is off — enable
      // it in Privacy first" is more use than "could not start".
      set({
        session: { phase: "refused", reason: e instanceof Error ? e.message : String(e) },
      });
    }
  },

  stop: async () => {
    await stopTeachSession();
    const current = get().session;
    if (current.phase === "recording") {
      set({ session: { phase: "ended", sessionId: current.sessionId, reason: "stopped" } });
    }
  },

  applyStatus: (payload) => {
    const state = get().session;
    const detail = payload.detail ?? null;
    switch (payload.state) {
      case "started":
        // Only trust a start for the session we asked for.
        if (state.phase === "recording" && payload.session_id !== state.sessionId) return;
        return;
      case "ended":
        if (state.phase !== "recording") return;
        set({
          session: {
            phase: "ended",
            sessionId: state.sessionId,
            reason: detail ?? "ended",
          },
        });
        return;
      case "refused":
        set({ session: { phase: "refused", reason: detail ?? "refused" } });
        return;
      case "frame_refused":
        // A per-frame refusal is not a session failure — it is the gate working,
        // and the user is told which rule stopped it.
        set({ skips: noteSkip(get().skips, detail ?? "refused") });
        return;
      case "inference_failed":
        set({ skips: noteSkip(get().skips, detail ?? "inference_failed") });
        return;
      default:
        return;
    }
  },

  applyObservation: (payload) => {
    // Charged first, and regardless of outcome: a frame the model could not read
    // still cost what it cost, and a spend total that only counted successes would
    // understate the bill.
    const reported = payload.usage;
    if (reported !== undefined) {
      const usages = [
        ...get().usages,
        {
          inputTokens: reported.input_tokens ?? 0,
          outputTokens: reported.output_tokens ?? 0,
        },
      ];
      const alias = useSettings.getState().settings.vision_model_alias;
      set({ usages, spend: sessionSpend(usages, visionSessionPrice(alias)) });
    }

    const result = readingsFromObservation(payload, appCategoryForBundle);
    if (!result.ok) {
      set({ skips: noteSkip(get().skips, result.skip.reason) });
      return;
    }
    let readings = get().readings;
    for (const reading of result.readings) readings = mergeReading(readings, reading);
    set({ readings, framesRead: get().framesRead + 1 });
  },

  setVerdict: (id, verdict) =>
    set({ readings: get().readings.map((r) => (r.id === id ? { ...r, verdict } : r)) }),

  keepAll: () =>
    set({
      readings: get().readings.map((r) =>
        r.verdict === "unreviewed" ? { ...r, verdict: "kept" } : r,
      ),
    }),

  discardAll: () =>
    set({
      readings: get().readings.map((r) =>
        r.verdict === "unreviewed" ? { ...r, verdict: "discarded" } : r,
      ),
    }),

  saveKept: async () => {
    const kept = get().readings.filter((r) => r.verdict === "kept");
    if (kept.length === 0) {
      set({ saved: 0 });
      return;
    }
    try {
      const events = kept.map(
        (r) =>
          eventFromReading(r.frame, r.action, {
            deviceId: DEVICE,
            userId: OWNER,
            organizationId: ORG,
          }) as unknown as WorkflowEvent,
      );
      // Through the SAME ingest path as every other source: the gate, redaction
      // check and forbidden-field scan all still apply. Teach Mode gets no
      // shortcut into the store for having been demonstrated by hand.
      const result = await ingestEvents(events, { observationPaused: false });
      set({ saved: result.stored, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "could not save what you kept" });
    }
  },

  reset: () =>
    set({
      session: { phase: "idle" },
      readings: [],
      skips: [],
      framesRead: 0,
      spend: { frames: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      usages: [],
      error: null,
      saved: null,
    }),
}));
