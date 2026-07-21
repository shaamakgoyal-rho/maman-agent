import { create } from "zustand";
import { petReceiptSummary, type ExecutionReceipt } from "@maman/contracts";
import type { ProposedDiff } from "@maman/agent-runtime";
import { invokeCommand } from "./bridge.js";
import type { RunPhase } from "./runs.js";

/**
 * Server-backed run controller (M18 §2).
 *
 * When the device is enrolled, runs execute through the durable server path:
 * the API starts the Temporal workflow, the panel polls for the pending
 * approval, renders the SAME ProposedDiff the local flow does, and Approve /
 * Reject signal the workflow (the approval is bound to step + diff hash
 * server-side — this only relays it). The receipt renders from the server's
 * immutable ExecutionReceipt. Every HTTP call originates in the Rust core with
 * the keychain device token; this store never holds a token.
 *
 * The local executor (lib/runs.ts) remains as the explicit "local demo run"
 * fallback when the device is not enrolled.
 */

/** Workflow statuses that mean the run has stopped (no further polling). */
const TERMINAL = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
  "expired",
  "policy_blocked",
]);

function phaseForStatus(status: string): RunPhase {
  switch (status) {
    case "validating":
    case "running_read":
      return "running_read";
    case "preparing_diff":
      return "preparing_diff";
    case "waiting_approval":
      return "waiting_approval";
    case "applying_write":
      return "applying_write";
    case "verifying":
      return "verifying";
    case "completed":
      return "completed";
    case "completed_with_warnings":
      return "completed_with_warnings";
    case "failed":
    case "policy_blocked":
      return "failed";
    default:
      return "cancelled"; // cancelled / expired
  }
}

export type ServerRunDeps = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  genKey: () => string;
  /** Poll interval + cap (kept small in tests). */
  pollMs?: number;
  maxPolls?: number;
};

export type ServerPending = { step_id: string; diff_sha256: string };

export type ServerRunsState = {
  phase: RunPhase;
  mode: "shadow" | "supervised";
  runId: string | null;
  diff: ProposedDiff | null;
  pending: ServerPending | null;
  receipt: ExecutionReceipt | null;
  receiptSummary: string | null;
  error: string | null;
  startShadow: (serverAgentId: string) => Promise<void>;
  startSupervised: (serverAgentId: string) => Promise<void>;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
  reset: () => void;
};

export function createServerRunStore(deps: ServerRunDeps) {
  const pollMs = deps.pollMs ?? 1000;
  const maxPolls = deps.maxPolls ?? 120;

  return create<ServerRunsState>((set, get) => {
    /** Polls run status until terminal; returns the final status string. */
    async function pollToTerminal(runId: string): Promise<string> {
      let status = "validating";
      for (let i = 0; i < maxPolls; i++) {
        const res = await deps.invoke<{ status: string }>("server_run_status", { runId });
        status = res.status;
        set({ phase: phaseForStatus(status) });
        if (TERMINAL.has(status)) break;
        await deps.sleep(pollMs);
      }
      return status;
    }

    /** Polls for a pending approval; returns it (or null if the run ended). */
    async function pollForPending(runId: string): Promise<ServerPending | null> {
      for (let i = 0; i < maxPolls; i++) {
        const res = await deps.invoke<{ pending: ServerPending | null }>(
          "server_pending_approval",
          {
            runId,
          },
        );
        if (res.pending) return res.pending;
        const status = (await deps.invoke<{ status: string }>("server_run_status", { runId }))
          .status;
        set({ phase: phaseForStatus(status) });
        if (TERMINAL.has(status)) return null;
        await deps.sleep(pollMs);
      }
      return null;
    }

    async function loadReceipt(runId: string): Promise<void> {
      const res = await deps.invoke<{ receipt: ExecutionReceipt | null }>("server_receipt", {
        runId,
      });
      if (res.receipt) {
        set({ receipt: res.receipt, receiptSummary: petReceiptSummary(res.receipt) });
      }
    }

    return {
      phase: "idle",
      mode: "shadow",
      runId: null,
      diff: null,
      pending: null,
      receipt: null,
      receiptSummary: null,
      error: null,

      startShadow: async (serverAgentId) => {
        set({
          phase: "running_read",
          mode: "shadow",
          diff: null,
          pending: null,
          receipt: null,
          receiptSummary: null,
          error: null,
        });
        try {
          const started = await deps.invoke<{ run_id: string }>("server_start_run", {
            agentId: serverAgentId,
            mode: "shadow",
            idempotencyKey: deps.genKey(),
          });
          set({ runId: started.run_id });
          const status = await pollToTerminal(started.run_id);
          // The proposed diff is surfaced even for shadow (it proposes, never writes).
          const proposal = await deps.invoke<{ diff: ProposedDiff | null }>("server_proposal", {
            runId: started.run_id,
          });
          if (proposal.diff) set({ diff: proposal.diff });
          await loadReceipt(started.run_id);
          set({ phase: phaseForStatus(status) });
        } catch (e) {
          set({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      },

      startSupervised: async (serverAgentId) => {
        set({
          phase: "running_read",
          mode: "supervised",
          diff: null,
          pending: null,
          receipt: null,
          receiptSummary: null,
          error: null,
        });
        try {
          const started = await deps.invoke<{ run_id: string }>("server_start_run", {
            agentId: serverAgentId,
            mode: "supervised",
            idempotencyKey: deps.genKey(),
          });
          set({ runId: started.run_id });
          const pending = await pollForPending(started.run_id);
          if (!pending) {
            // The run ended before proposing a write (e.g. policy blocked).
            await loadReceipt(started.run_id);
            const status = (
              await deps.invoke<{ status: string }>("server_run_status", {
                runId: started.run_id,
              })
            ).status;
            set({ phase: phaseForStatus(status) });
            return;
          }
          const proposal = await deps.invoke<{ diff: ProposedDiff | null }>("server_proposal", {
            runId: started.run_id,
          });
          set({ phase: "waiting_approval", pending, diff: proposal.diff });
        } catch (e) {
          set({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      },

      approve: async () => {
        const { runId, pending } = get();
        if (!runId || !pending) return;
        set({ phase: "applying_write", pending: null });
        try {
          await deps.invoke("server_approve_run", {
            runId,
            stepId: pending.step_id,
            diffHash: pending.diff_sha256,
          });
          const status = await pollToTerminal(runId);
          await loadReceipt(runId);
          set({ phase: phaseForStatus(status) });
        } catch (e) {
          set({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      },

      reject: async () => {
        const { runId, pending } = get();
        if (!runId || !pending) {
          set({ phase: "cancelled", pending: null });
          return;
        }
        try {
          await deps.invoke("server_reject_run", {
            runId,
            stepId: pending.step_id,
            reason: "rejected",
          });
        } catch {
          // The run cancels either way; surface cancelled.
        }
        set({ phase: "cancelled", pending: null });
      },

      reset: () =>
        set({
          phase: "idle",
          runId: null,
          diff: null,
          pending: null,
          receipt: null,
          receiptSummary: null,
          error: null,
        }),
    };
  });
}

export const useServerRuns = createServerRunStore({
  invoke: invokeCommand,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  genKey: () =>
    globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});
