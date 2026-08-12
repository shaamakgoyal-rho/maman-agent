import { useState } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { product } from "@maman/config";
import { ALLOWLIST_PRESETS, bundlesForDomains, useSettings } from "../../state/settings.js";
import { useEnrollment } from "../../state/enrollment.js";
import { isTauri } from "../../lib/bridge.js";
import { Button, Card, Muted, SectionTitle } from "../ui.js";

/**
 * Journey A: first launch and consent. Observation stays OFF until this flow
 * completes, and completing it requires the privacy comprehension confirmation.
 * Denying anything degrades capability with an explanation — never a crash.
 */

const STEPS = ["welcome", "boundaries", "allowlist", "permissions", "comprehension"] as const;
type CoreStep = (typeof STEPS)[number];
// "connect" is an OPTIONAL post-consent step (M18) — not part of the consent
// gate and never required. It is reachable only via an explicit opt-in.
type Step = CoreStep | "connect";

export function Onboarding() {
  const { settings, update } = useSettings();
  const enrollment = useEnrollment();
  const [step, setStep] = useState<Step>("welcome");
  const [selectedDomains, setSelectedDomains] = useState<string[]>(settings.allowlist_domains);
  const [confirmations, setConfirmations] = useState({
    replay: false,
    pause: false,
    writes: false,
  });

  const coreIndex = STEPS.indexOf(step as CoreStep);
  const stepIndex = coreIndex === -1 ? STEPS.length - 1 : coreIndex;
  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(stepIndex - 1, 0)]!);

  const allConfirmed = confirmations.replay && confirmations.pause && confirmations.writes;

  const finish = async (observe: boolean) => {
    await update({
      onboarding_complete: true,
      comprehension_confirmed: true,
      allowlist_domains: selectedDomains,
      // Allowing a SITE has to imply the browser it runs in, or the AX observer
      // — which gates on bundle ids — drops everything and a fully consented
      // install observes nothing at all. See `bundlesForDomains`.
      allowlist_bundles: bundlesForDomains(selectedDomains, settings.allowlist_bundles),
      observation_paused: !observe,
      paused_until: null,
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 p-5 overflow-y-auto">
      <div aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`} className="flex gap-1.5">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full ${i <= stepIndex ? "bg-primary" : "bg-line"}`}
          />
        ))}
      </div>

      {step === "welcome" && (
        <>
          <h1 className="text-lg font-semibold">Hi, I'm {product.mascot.name}.</h1>
          <Muted>
            I notice repetitive work you've stopped noticing, and I can draft safe helpers for it.
            Before anything else: you decide exactly what I can see, and you can change your mind at
            any time.
          </Muted>
          <Card>
            <SectionTitle>How this works</SectionTitle>
            <ul className="space-y-2 text-xs text-muted leading-relaxed list-disc pl-4">
              <li>I only observe applications and sites you allow.</li>
              <li>I see the shape of your work (clicks, pages, records) — never what you type.</li>
              <li>Everything I observe stays encrypted on this Mac.</li>
              <li>Helpers I draft never change anything without your explicit approval.</li>
            </ul>
          </Card>
          <div className="mt-auto flex justify-end">
            <Button onClick={next}>Get started</Button>
          </div>
        </>
      )}

      {step === "boundaries" && (
        <>
          <h1 className="text-lg font-semibold">What I can and can't see</h1>
          <Card>
            <SectionTitle>I can observe (only if you allow it)</SectionTitle>
            <Muted>
              Which allowed app or site is active, what kind of element you interact with, which
              type of record or page you're on, and how long steps take.
            </Muted>
          </Card>
          <Card>
            <SectionTitle>I never observe</SectionTitle>
            <Muted>
              Keystrokes or typed text. Passwords, one-time codes, or payment fields. Password
              managers, private browsing, banking or health sites. Your screen — except in Teach
              Mode, which you start yourself, see a recording indicator for, and which never writes
              frames to disk.
            </Muted>
          </Card>
          <Card>
            <SectionTitle>What stays local vs. what your company sees</SectionTitle>
            <Muted>
              Raw observations stay on this Mac, encrypted. Your company sees aggregate adoption and
              value across teams of five or more — never your screen, your history, or a
              productivity ranking. Those APIs don't exist.
            </Muted>
          </Card>
          <div className="mt-auto flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>Choose what I observe</Button>
          </div>
        </>
      )}

      {step === "allowlist" && (
        <>
          <h1 className="text-lg font-semibold">Choose what I may observe</h1>
          <Muted>
            These are suggestions for sales work — nothing is enabled until you check it. You can
            change this list anytime in Privacy. Allowing a site also lets me watch the browser it
            runs in, at the level of which app and which kind of element — that is how I notice the
            work itself.
          </Muted>
          <Card>
            <div className="space-y-1">
              {ALLOWLIST_PRESETS.map((preset) => (
                <label
                  key={preset.domain}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-bg cursor-pointer"
                >
                  <Checkbox.Root
                    checked={selectedDomains.includes(preset.domain)}
                    onCheckedChange={(v) =>
                      setSelectedDomains((prev) =>
                        v === true
                          ? [...prev, preset.domain]
                          : prev.filter((d) => d !== preset.domain),
                      )
                    }
                    className="flex h-4 w-4 items-center justify-center rounded border border-line bg-panel data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                  >
                    <Checkbox.Indicator className="text-white text-[10px] leading-none">
                      ✓
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <span className="text-sm">{preset.label}</span>
                  <span className="ml-auto text-xs text-muted">{preset.domain}</span>
                </label>
              ))}
            </div>
          </Card>
          <div className="mt-auto flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>
              Continue{selectedDomains.length === 0 ? " (observe nothing)" : ""}
            </Button>
          </div>
        </>
      )}

      {step === "permissions" && (
        <>
          <h1 className="text-lg font-semibold">macOS permissions</h1>
          <Muted>
            Each permission unlocks one capability. Denying any of them never breaks the app — I'll
            simply do less, and you can grant them later from Settings.
          </Muted>
          <Card>
            <SectionTitle>Accessibility — optional</SectionTitle>
            <Muted>
              Lets me see which allowed desktop app and element type is active. Requested only when
              you enable desktop observation. Without it, I observe browser activity only.
            </Muted>
          </Card>
          <Card>
            <SectionTitle>Teach Mode — coming soon, always yours to start</SectionTitle>
            <Muted>
              Show Maman a workflow once — coming soon. You start it, you see an indicator while it
              runs, nothing is kept on disk, and it is never used in the background. The macOS
              Screen Recording permission is requested only at that moment, never in advance.
            </Muted>
          </Card>
          <Card>
            <SectionTitle>Chrome extension — optional</SectionTitle>
            <Muted>
              Adds semantic browser observation on the sites you allowed. Installation is guided
              from Settings → Connectors when you're ready.
            </Muted>
          </Card>
          <div className="mt-auto flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>Continue</Button>
          </div>
        </>
      )}

      {step === "comprehension" && (
        <>
          <h1 className="text-lg font-semibold">Three things worth confirming</h1>
          <Muted>Check each statement — this is your privacy contract with {product.name}.</Muted>
          <Card>
            <div className="space-y-3">
              {(
                [
                  ["replay", "My manager cannot replay my screen."],
                  ["pause", "I can pause observation at any time."],
                  ["writes", "An agent cannot perform material writes until I approve it."],
                ] as const
              ).map(([key, text]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <Checkbox.Root
                    checked={confirmations[key]}
                    onCheckedChange={(v) =>
                      setConfirmations((prev) => ({ ...prev, [key]: v === true }))
                    }
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line bg-panel data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                  >
                    <Checkbox.Indicator className="text-white text-[10px] leading-none">
                      ✓
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <span className="text-sm leading-snug">“{text}”</span>
                </label>
              ))}
            </div>
          </Card>
          <div className="mt-auto flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Button variant="secondary" onClick={back}>
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void finish(false)}
                  disabled={!allConfirmed}
                >
                  Finish, stay paused
                </Button>
                <Button onClick={() => void finish(true)} disabled={!allConfirmed}>
                  Finish and start observing
                </Button>
              </div>
            </div>
            {/* Optional, post-consent: never required to finish. */}
            <button
              type="button"
              disabled={!allConfirmed}
              onClick={() => setStep("connect")}
              className="self-end text-xs text-primary underline underline-offset-2 disabled:opacity-40"
            >
              Run helpers on the server (optional) →
            </button>
          </div>
        </>
      )}

      {step === "connect" && (
        <>
          <h1 className="text-lg font-semibold">Run helpers on the server (optional)</h1>
          <Muted>
            You can run everything locally — this is optional. Enrolling this device lets Maman run
            approved helpers on the server (durable runs, server-side model, connector vault) and
            sync redacted activity. Your device token is stored in the macOS keychain and never
            reaches this window. You can enroll or disconnect anytime in Settings.
          </Muted>
          <Card>
            {!isTauri() ? (
              <Muted>
                Enrollment needs the desktop app — the web preview runs local demo runs.
              </Muted>
            ) : enrollment.phase === "enrolled" ? (
              <p className="text-sm">Enrolled ✓ — server runs are available.</p>
            ) : (
              <Button
                disabled={enrollment.phase === "enrolling"}
                onClick={() => void enrollment.enroll()}
              >
                {enrollment.phase === "enrolling" ? "Enrolling…" : "Enroll this device"}
              </Button>
            )}
            {enrollment.error && (
              <p className="mt-2 text-xs text-danger">Enrollment problem: {enrollment.error}</p>
            )}
          </Card>
          <div className="mt-auto flex items-center justify-between">
            <Button variant="secondary" onClick={() => setStep("comprehension")}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void finish(false)}>
                Finish, stay paused
              </Button>
              <Button onClick={() => void finish(true)}>Finish and start observing</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
