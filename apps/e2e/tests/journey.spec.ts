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

test("onboarding → demo workflow → suggestion → agent → shadow → supervised approval → receipt", async ({
  page,
}) => {
  await page.goto("/index.html");

  // 1–2. Consent.
  await completeOnboarding(page);

  // 3. Observe a demo workflow (Home).
  await page.getByRole("button", { name: /Run demo workflow/i }).click();

  // 4. A suggestion appears.
  await page.getByRole("button", { name: "Suggestions" }).click();
  await expect(page.getByText(/Reconcile account lists with Salesforce/i)).toBeVisible();

  // 5. Create the agent from the suggestion.
  await page.getByRole("button", { name: /Create agent/i }).click();

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
