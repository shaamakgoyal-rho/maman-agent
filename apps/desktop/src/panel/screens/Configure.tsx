import { useState } from "react";
import { workflowReadiness, type LearnedStep } from "@maman/contracts";
import { useLearnedWorkflows } from "../../lib/learnedWorkflows.js";
import { useSettings } from "../../state/settings.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";

/**
 * CONFIGURE — where the user tells Maman what it could not observe.
 *
 * The screen exists because of a specific, repeated failure: Maman knew a
 * workflow repeated but not which field it touched or what value belonged
 * there, and every attempt to infer those produced a helper the user had not
 * described. So this screen asks, and until it is answered the workflow stays
 * unrunnable and says why.
 *
 * Three things it is built to make unavoidable:
 *
 * 1. WHAT IS MISSING IS NAMED, PER STEP. Not "needs configuration" but "which
 *    field does step 2 act on".
 * 2. NOTHING IS PRE-FILLED WITH A GUESS. Empty means unknown. A placeholder
 *    that looked like an answer is how a user ends up approving something they
 *    never chose.
 * 3. A CREDENTIAL CANNOT BE TYPED IN AS A CONSTANT. The schema rejects it, and
 *    the field says so before the user tries.
 */

/** Roles a user can pick, in the words they see on a page. */
const ROLE_CHOICES: Array<{ value: NonNullable<LearnedStep["target"]>["role"]; label: string }> = [
  { value: "textbox", label: "a text field" },
  { value: "combobox", label: "a dropdown" },
  { value: "checkbox", label: "a checkbox" },
  { value: "button", label: "a button" },
  { value: "cell", label: "a table cell" },
  { value: "link", label: "a link" },
];

export function Configure({ workflowId, onDone }: { workflowId: string; onDone: () => void }) {
  const { workflows, update } = useLearnedWorkflows();
  const settings = useSettings((s) => s.settings);
  const workflow = workflows.find((w) => w.workflow_id === workflowId);
  const [error, setError] = useState<string | null>(null);

  if (!workflow) {
    return <EmptyState title="Workflow not found" body="It may have been removed." />;
  }

  const readiness = workflowReadiness(workflow);
  const missingFor = (stepId: string) => readiness.missing.filter((m) => m.step_id === stepId);

  const save = async (edit: Parameters<typeof update>[1]) => {
    setError(null);
    try {
      await update(workflowId, edit);
    } catch (e) {
      // A failed save is stated. Silently keeping an edit in memory would let
      // the user configure a workflow that is not actually persisted.
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  };

  const setStep = async (stepId: string, patch: Partial<LearnedStep>) => {
    await save({
      steps: workflow.steps.map((s) => (s.step_id === stepId ? { ...s, ...patch } : s)),
    });
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-start justify-between gap-2">
          <SectionTitle>Teach me this workflow</SectionTitle>
          <StatusPill tone={readiness.ready ? "success" : "warning"}>
            {readiness.ready ? "ready to build" : `${readiness.missing.length} to answer`}
          </StatusPill>
        </div>
        <Muted>
          I noticed this repeats, but I never saw which fields mattered or what values belong in
          them — I don&apos;t record what you type. Fill these in and I can build a helper that does
          exactly this and nothing else.
        </Muted>

        <label className="mt-2 block text-xs font-medium text-ink">
          What should I call it?
          <input
            className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
            value={workflow.name}
            onChange={(e) => void save({ name: e.target.value })}
          />
        </label>

        <label className="mt-2 block text-xs font-medium text-ink">
          Which site does it run on?
          <select
            className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
            value={workflow.allowed_origins[0] ?? ""}
            onChange={(e) => void save({ allowed_origins: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">— choose a site —</option>
            {settings.browser_actuation_origins.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        {settings.browser_actuation_origins.length === 0 && (
          <Muted>
            No sites are allowed for actuation yet. Add one in Settings first — I will not act on a
            site you have not named.
          </Muted>
        )}
      </Card>

      {workflow.steps.map((step) => (
        <Card key={step.step_id}>
          <div className="flex items-start justify-between gap-2">
            <SectionTitle>
              Step {step.order}: {step.description}
            </SectionTitle>
            <StatusPill tone={missingFor(step.step_id).length === 0 ? "success" : "warning"}>
              {step.mode === "read" ? "reads" : "writes"}
            </StatusPill>
          </div>

          {missingFor(step.step_id).map((m, i) => (
            <p key={i} className="mt-1 text-xs text-warning">
              {m.detail}
            </p>
          ))}

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-ink">
              What kind of thing?
              <select
                className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
                value={step.target?.role ?? ""}
                onChange={(e) =>
                  void setStep(step.step_id, {
                    target: e.target.value
                      ? {
                          role: e.target.value as NonNullable<LearnedStep["target"]>["role"],
                          name: step.target?.name ?? "",
                        }
                      : undefined,
                  })
                }
              >
                <option value="">— choose —</option>
                {ROLE_CHOICES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-medium text-ink">
              What is it labelled?
              <input
                className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
                placeholder="e.g. Phone"
                value={step.target?.name ?? ""}
                onChange={(e) =>
                  void setStep(step.step_id, {
                    target: {
                      role: step.target?.role ?? "textbox",
                      name: e.target.value,
                    },
                  })
                }
              />
            </label>
          </div>
          <Muted>
            Use the label you see on the page. I match it exactly, and refuse if two fields share it
            — guessing between them is how a helper types into the wrong box.
          </Muted>

          {step.mode !== "read" && (
            <div className="mt-2">
              <span className="text-xs font-medium text-ink">Where does the value come from?</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(
                  [
                    ["prompt", "ask me each time"],
                    ["constant", "always the same"],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    className={`rounded-full px-2.5 py-1 text-xs ${
                      step.value?.kind === kind
                        ? "bg-primary text-white"
                        : "border border-line bg-panel text-muted"
                    }`}
                    onClick={() =>
                      void setStep(step.step_id, {
                        value:
                          kind === "prompt"
                            ? {
                                kind: "prompt",
                                label: step.target?.name || "Value",
                                required: true,
                              }
                            : { kind: "constant", value: "" },
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              {step.value?.kind === "constant" && (
                <>
                  <input
                    className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
                    placeholder="the value to type"
                    value={step.value.value}
                    onChange={(e) =>
                      void setStep(step.step_id, {
                        value: { kind: "constant", value: e.target.value },
                      })
                    }
                  />
                  <Muted>
                    Never a password, key or token. I refuse to store those here — they belong in
                    your keychain, not in a workflow.
                  </Muted>
                </>
              )}
              {step.value?.kind === "prompt" && (
                <Muted>I will ask you for this every time the helper runs.</Muted>
              )}
            </div>
          )}
        </Card>
      ))}

      {error && (
        <Card>
          <p className="text-xs text-danger">{error}</p>
        </Card>
      )}

      <Card>
        {readiness.ready ? (
          <Muted>
            Everything I need is here. Building it will show you the exact plan before anything
            runs, and any change still waits for your approval.
          </Muted>
        ) : (
          <>
            <p className="text-sm text-ink">Still needed:</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted list-disc pl-4">
              {readiness.missing.map((m, i) => (
                <li key={i}>{m.detail}</li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-2 flex gap-2">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Card>
    </div>
  );
}
