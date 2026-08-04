import { test, expect, type Page } from "@playwright/test";

/**
 * The LIVE arc, driven through the real panel UI: Live-demo preset →
 * relay-shaped repetitions ingested one click at a time (exactly what the
 * Chrome relay records: no durations, field commits, URL-derived context) →
 * the pattern visibly FORMS → becomes a replay-verified card → Try it →
 * shadow (no write) → supervised approval → receipt. Companion to
 * journey.spec.ts (the seeded 23-run arc) and docs/LIVE_DEMO.md.
 */

async function completeOnboarding(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click(); // welcome
  await page.getByRole("button", { name: "Choose what I observe" }).click(); // boundaries
  await page.getByRole("button", { name: /^Continue/ }).click(); // allowlist
  await page.getByRole("button", { name: /^Continue/ }).click(); // permissions
  const finish = page.getByRole("button", { name: "Finish and start observing" });
  await expect(finish).toBeDisabled();
  await page.getByText("My manager cannot replay my screen.").click();
  await page.getByText("I can pause observation at any time.").click();
  await page.getByText("An agent cannot perform material writes until I approve it.").click();
  await expect(finish).toBeEnabled();
  await finish.click();
}

test("live arc: preset → 4 relay-shaped reps → forming → verified card → Try it → approval → receipt", async ({
  page,
}) => {
  await page.goto("/index.html");
  await completeOnboarding(page);

  // 1. Turn on the Live-demo preset — an honest banner flags the tuning.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Live demo preset" }).click();
  await expect(page.getByText(/Detection bars are below production defaults/i)).toBeVisible();

  // 2. Two live reps: the pattern is visibly FORMING, not yet a card.
  const simulate = page.getByRole("button", { name: /Simulate live workflow rep/ });
  await page.getByRole("button", { name: "Home" }).click();
  await simulate.click();
  await simulate.click();
  await page.getByRole("button", { name: "Suggestions" }).click();
  await expect(page.getByText(/Forming — what I'm watching/i)).toBeVisible();
  // The card names the work and the app it happens in ("Update account records
  // in Salesforce"), and states the observed steps underneath — a title like
  // "Automate your record workflow" told the reader nothing.
  await expect(page.getByText(/Update account records in Salesforce/i).first()).toBeVisible();
  // The steps line, in prose. Asserted loosely on purpose: the exact verbs
  // depend on which events the relay produced, and pinning them would make this
  // test a copy snapshot rather than a check that the card explains itself.
  await expect(page.getByText(/^You .+\.$/).first()).toBeVisible();

  // 3. Two more reps clear every bar + replay verification → the card.
  await page.getByRole("button", { name: "Home" }).click();
  await simulate.click();
  await simulate.click();
  await page.getByRole("button", { name: "Suggestions" }).click();
  await expect(page.getByText(/tested it against your last/i)).toBeVisible();
  await expect(page.getByText(/runs and matched/i)).toBeVisible();

  // 4. Try it → the draft compiles from the pattern's own derived intent.
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("button", { name: "Run shadow" })).toBeVisible();

  // 5. Shadow: proposes the diff, writes nothing.
  await page.getByRole("button", { name: "Run shadow" }).click();
  await expect(page.getByText(/Proposed diff/i)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // 6. Supervised: the write waits for a human, bound to the exact diff.
  await page.getByRole("button", { name: "Run supervised" }).click();
  const approve = page.getByRole("button", { name: /Approve & write once/i });
  await expect(approve).toBeVisible();
  await expect(page.getByText(/Approval required before any write/i)).toBeVisible();
  await approve.click();

  // 7. Receipt with measured ROI; the approved run ticks the autonomy meter.
  await expect(page.getByText(/Updated 4 records\. Saved approximately/i)).toBeVisible();
  await expect(page.getByText(/ROI measured · verification passed/i)).toBeVisible();
  await expect(page.getByText(/1\/5/)).toBeVisible();
});
