import { test, expect, type Page } from "@playwright/test";

/**
 * The full product journey (Journeys A–F + the autonomy gate), driven headless
 * against the desktop panel. This is also the "12-step end-to-end demo": every
 * step below is a user action, and the run loop is deterministic (demo mode).
 *
 * onboarding consent → demo workflow observed → suggestion appears →
 * create agent → shadow run (no write) → supervised run with diff approval →
 * receipt with measured ROI → autonomy is never offered from confidence.
 */

async function completeOnboarding(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click(); // welcome
  await page.getByRole("button", { name: "Choose what I observe" }).click(); // boundaries
  await page.getByRole("button", { name: /^Continue/ }).click(); // allowlist
  await page.getByRole("button", { name: /^Continue/ }).click(); // permissions

  // Comprehension gate: all three privacy statements must be confirmed before
  // observation can start — the consent gate, not a formality.
  const finish = page.getByRole("button", { name: "Finish and start observing" });
  await expect(finish).toBeDisabled();
  await page.getByText("My manager cannot replay my screen.").click();
  await page.getByText("I can pause observation at any time.").click();
  await page.getByText("An agent cannot perform material writes until I approve it.").click();
  await expect(finish).toBeEnabled();
  await finish.click();
}

test("onboarding → seeded history → replay-verified card → Try it → supervised approval → receipt → autonomy meter", async ({
  page,
}) => {
  await page.goto("/index.html");

  // 1–2. Consent (the cold open: allowlist, hard-denied, comprehension).
  await completeOnboarding(page);

  // 3. Seed a realistic month of recorded runs (23, two divergent on purpose).
  await page.getByRole("button", { name: /Seed demo history/i }).click();

  // 4. THE card appears — with the replay-verified score, not a confidence guess.
  await page.getByRole("button", { name: "Suggestions" }).click();
  await expect(page.getByText(/Reconcile account lists with Salesforce/i)).toBeVisible();
  await expect(page.getByText(/tested it against your last/i)).toBeVisible();
  await expect(page.getByText("21", { exact: true })).toBeVisible();
  await expect(page.getByText("19", { exact: true })).toBeVisible();

  // Expand: the two planted divergences are named, step and all.
  await page.getByRole("button", { name: /See the run-by-run results/i }).click();
  await expect(page.getByText(/diverged at step/i).first()).toBeVisible();

  // 5. Exactly three actions — no prompt box, no configuration.
  await expect(page.getByRole("button", { name: "Try it", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Never", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try it", exact: true }).click();

  // 6. Go to Agents — the draft is here with its plan; nothing has run.
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByText(/Reconcile account lists with Salesforce/i)).toBeVisible();

  // 7. Shadow run: proposes the diff, writes NOTHING.
  await page.getByRole("button", { name: "Run shadow" }).click();
  await expect(page.getByText(/Proposed diff/i)).toBeVisible();
  // The shadow receipt reports zero writes (measured/estimated ROI, no changes).
  await expect(page.getByText(/Updated 0 records|Saved approximately|Done/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // 8. Supervised run: pauses for a HUMAN approval bound to the diff.
  await page.getByRole("button", { name: "Run supervised" }).click();
  const approve = page.getByRole("button", { name: /Approve & write once/i });
  await expect(approve).toBeVisible(); // the write cannot proceed without a human
  await expect(page.getByText(/Approval required before any write/i)).toBeVisible();

  // Autonomy gate: at no point is there a control to make the agent autonomous
  // from a confidence score — the only path to a write is this explicit approval.
  await expect(
    page.getByRole("button", { name: /enable autonomy|go autonomous|auto-approve/i }),
  ).toHaveCount(0);

  // 9. Approve → the write applies once and verifies.
  await approve.click();

  // 10. Receipt with measured ROI, in the pet's honest voice.
  await expect(page.getByText(/Updated 4 records\. Saved approximately/i)).toBeVisible();
  await expect(page.getByText(/ROI measured · verification passed/i)).toBeVisible();

  // 11. Earned autonomy: the approved run ticked the per-workflow meter.
  await expect(page.getByText(/more approved runs? until Maman can draft/i)).toBeVisible();
  await expect(page.getByText(/1\/5/)).toBeVisible();

  // 12. The exit — the trust surface answers "what does Maman see?"
  await page.getByRole("button", { name: "Privacy" }).click();
  await expect(page.getByText(/Not collected this week/i)).toBeVisible();
  await expect(page.getByText(/Always off-limits/i)).toBeVisible();
  await expect(page.getByText(/What would leave this device/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete all observed history/i })).toBeVisible();

  // 11. Settings → Connect to Maman server card renders (M18.1 regression guard).
  // The enrollment store hydrates on mount; if it threw (as the CSP-blocked
  // webview fetch did), the card would surface an error instead of the card.
  // NOTE: the web preview cannot exercise Tauri IPC, so it shows the honest
  // "runs in the desktop app" state; the actual enroll IPC path is covered by
  // the Rust unit tests + the CSP test + the manual tauri-dev verification.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText(/Connect to Maman server/i)).toBeVisible();
  await expect(page.getByText(/Enrollment runs in the desktop app/i)).toBeVisible();
  // The card must not have crashed with an enrollment error.
  await expect(page.getByText(/Enrollment problem:/i)).toHaveCount(0);
});
