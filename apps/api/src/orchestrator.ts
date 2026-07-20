import type { WorkflowClient } from "@temporalio/client";
import type { AgentRunInput, AgentSpec } from "@maman/contracts";

/**
 * The API's only handle to the durable run engine. Starting, querying, and
 * signalling all go through this seam so the HTTP routes never import the
 * Temporal workflow sandbox module, and tests can inject a client bound to a
 * TestWorkflowEnvironment. Workflow/signal/query are referenced by their
 * registered names (defined in @maman/agent-runtime/workflow).
 */

export type PendingApproval = { step_id: string; diff_sha256: string } | null;

export interface RunOrchestrator {
  startRun(input: {
    workflowId: string;
    run: AgentRunInput;
    spec: AgentSpec;
    model_cost_usd?: number;
  }): Promise<void>;
  getStatus(workflowId: string): Promise<string>;
  getPendingApproval(workflowId: string): Promise<PendingApproval>;
  approve(
    workflowId: string,
    payload: { step_id: string; diff_hash: string; approver_user_id: string },
  ): Promise<void>;
  reject(workflowId: string, payload: { step_id: string; reason: string }): Promise<void>;
  cancel(workflowId: string, payload: { actor_user_id: string; reason: string }): Promise<void>;
}

const WORKFLOW_TYPE = "agentRunWorkflow";
const TASK_QUEUE_DEFAULT = "maman-agent-runs";

/** Temporal-backed orchestrator over a WorkflowClient (real or test env). */
export class TemporalRunOrchestrator implements RunOrchestrator {
  constructor(
    private readonly client: WorkflowClient,
    private readonly taskQueue: string = TASK_QUEUE_DEFAULT,
  ) {}

  async startRun(input: {
    workflowId: string;
    run: AgentRunInput;
    spec: AgentSpec;
    model_cost_usd?: number;
  }): Promise<void> {
    await this.client.start(WORKFLOW_TYPE, {
      taskQueue: this.taskQueue,
      workflowId: input.workflowId,
      args: [{ run: input.run, spec: input.spec, model_cost_usd: input.model_cost_usd ?? 0 }],
    });
  }

  async getStatus(workflowId: string): Promise<string> {
    return this.client.getHandle(workflowId).query<string>("get_status");
  }

  async getPendingApproval(workflowId: string): Promise<PendingApproval> {
    return this.client.getHandle(workflowId).query<PendingApproval>("get_pending_approval");
  }

  async approve(
    workflowId: string,
    payload: { step_id: string; diff_hash: string; approver_user_id: string },
  ): Promise<void> {
    await this.client.getHandle(workflowId).signal("approve_step", payload);
  }

  async reject(workflowId: string, payload: { step_id: string; reason: string }): Promise<void> {
    await this.client.getHandle(workflowId).signal("reject_step", payload);
  }

  async cancel(
    workflowId: string,
    payload: { actor_user_id: string; reason: string },
  ): Promise<void> {
    await this.client.getHandle(workflowId).signal("cancel_run", payload);
  }
}
