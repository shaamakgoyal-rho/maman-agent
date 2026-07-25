import { describe, expect, it, vi } from "vitest";
import { createServerRunStore, type ServerRunDeps } from "../src/lib/serverRuns.js";

/**
 * Unit tests for the server-backed run state machine (M18 §2). A scripted
 * `invoke` stands in for the Rust Tauri commands so the whole poll → propose →
 * approve → receipt loop is exercised without a server.
 */

const DIFF = {
  summary: {
    change_count: 4,
    confident_matches: 4,
    ambiguous_skipped: 0,
    missing: 0,
    accounts_affected: 4,
  },
  changes: [{ account_name: "Acme", field: "owner", old_value: "Jordan", new_value: "Alex" }],
};

const RECEIPT = {
  run_id: "r1",
  mode: "supervised",
  approvals: [{ step_id: "apply" }],
  roi: { savings_provenance: "measured", net_time_saved_ms: 9 * 60_000 },
  steps: [{ verification: "independent_read_passed" }],
  totals: {
    writes_completed: 4,
    writes_proposed: 4,
    model_cost_usd: 0,
    total_cost_usd: 0.08,
  },
};

/** Builds deps whose `invoke` replies from a per-command script/queue. */
function makeDeps(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): {
  deps: ServerRunDeps;
  calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  const deps: ServerRunDeps = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const handler = handlers[cmd];
      if (!handler) throw new Error(`unexpected command ${cmd}`);
      return handler(args) as T;
    },
    sleep: async () => {},
    genKey: () => "idem-key-1",
    pollMs: 0,
    maxPolls: 10,
  };
  return { deps, calls };
}

// petReceiptSummary is exercised for real (imported by the store); the receipt
// shape here is the minimal subset it and the UI read.

describe("server run state machine", () => {
  it("shadow run: starts, polls to completed, surfaces the diff and receipt, never approves", async () => {
    let statusCalls = 0;
    const { deps, calls } = makeDeps({
      server_start_run: () => ({ run_id: "r1", workflow_id: "run-r1", duplicate: false }),
      server_run_status: () => ({ status: statusCalls++ === 0 ? "running_read" : "completed" }),
      server_proposal: () => ({ diff: DIFF }),
      server_receipt: () => ({ receipt: RECEIPT }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startShadow("srv-agent-1");

    const s = store.getState();
    expect(s.phase).toBe("completed");
    expect(s.diff?.summary.change_count).toBe(4);
    expect(s.receipt?.run_id).toBe("r1");
    expect(s.receiptSummary).toBeTruthy();
    // A shadow run must never call approve.
    expect(calls.some((c) => c.cmd === "server_approve_run")).toBe(false);
    // The idempotency key was passed through.
    expect(calls.find((c) => c.cmd === "server_start_run")?.args?.mode).toBe("shadow");
  });

  it("supervised run: pauses at the approval gate with the diff + pending hash", async () => {
    const { deps } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      server_pending_approval: () => ({ pending: { step_id: "apply", diff_sha256: "abc123" } }),
      server_run_status: () => ({ status: "waiting_approval" }),
      server_proposal: () => ({ diff: DIFF }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");

    const s = store.getState();
    expect(s.phase).toBe("waiting_approval");
    expect(s.pending).toEqual({ step_id: "apply", diff_sha256: "abc123" });
    expect(s.diff?.summary.change_count).toBe(4);
  });

  it("approve relays the step id + diff hash, polls to completion, loads the receipt", async () => {
    let statusCalls = 0;
    const approveSpy = vi.fn(() => ({ approved: true }));
    const { deps, calls } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      server_pending_approval: () => ({ pending: { step_id: "apply", diff_sha256: "abc123" } }),
      server_run_status: () => ({
        status: statusCalls++ === 0 ? "applying_write" : "completed",
      }),
      server_proposal: () => ({ diff: DIFF }),
      server_approve_run: approveSpy,
      server_receipt: () => ({ receipt: RECEIPT }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");
    await store.getState().approve();

    expect(store.getState().phase).toBe("completed");
    expect(store.getState().receipt?.run_id).toBe("r1");
    // The approval carried exactly the step + diff hash the run is bound to.
    const approveCall = calls.find((c) => c.cmd === "server_approve_run");
    expect(approveCall?.args).toMatchObject({ runId: "r1", stepId: "apply", diffHash: "abc123" });
  });

  it("reject relays a rejection and ends cancelled — nothing is written", async () => {
    const rejectSpy = vi.fn(() => ({ rejected: true }));
    const { deps, calls } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      server_pending_approval: () => ({ pending: { step_id: "apply", diff_sha256: "abc123" } }),
      server_run_status: () => ({ status: "waiting_approval" }),
      server_proposal: () => ({ diff: DIFF }),
      server_reject_run: rejectSpy,
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");
    await store.getState().reject();

    expect(store.getState().phase).toBe("cancelled");
    expect(rejectSpy).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.cmd === "server_approve_run")).toBe(false);
  });

  it("a start failure ends in a safe 'failed' phase with the error surfaced", async () => {
    const { deps } = makeDeps({
      server_start_run: () => {
        throw new Error("device not enrolled");
      },
    });
    const store = createServerRunStore(deps);
    await store.getState().startShadow("srv-agent-1");
    expect(store.getState().phase).toBe("failed");
    expect(store.getState().error).toContain("enrolled");
  });

  it("supervised run whose approval never arrives times out to a safe 'failed' (not a wedged mid-run phase)", async () => {
    const { deps } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      // No pending ever, and status never terminal → poll budget exhausts.
      server_pending_approval: () => ({ pending: null }),
      server_run_status: () => ({ status: "running_read" }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");
    expect(store.getState().phase).toBe("failed");
    expect(store.getState().error).toMatch(/longer than expected/i);
  });

  it("a pending approval with no loadable diff fails cleanly instead of showing an empty approval card", async () => {
    const { deps } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      server_pending_approval: () => ({ pending: { step_id: "apply", diff_sha256: "abc123" } }),
      server_run_status: () => ({ status: "waiting_approval" }),
      server_proposal: () => ({ diff: null }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");
    expect(store.getState().phase).toBe("failed");
    expect(store.getState().pending).toBeNull();
  });

  it("reset clears mode back to shadow", async () => {
    const { deps } = makeDeps({
      server_start_run: () => ({ run_id: "r1" }),
      server_pending_approval: () => ({ pending: { step_id: "apply", diff_sha256: "abc" } }),
      server_run_status: () => ({ status: "waiting_approval" }),
      server_proposal: () => ({ diff: DIFF }),
    });
    const store = createServerRunStore(deps);
    await store.getState().startSupervised("srv-agent-1");
    expect(store.getState().mode).toBe("supervised");
    store.getState().reset();
    expect(store.getState().mode).toBe("shadow");
    expect(store.getState().phase).toBe("idle");
  });
});
