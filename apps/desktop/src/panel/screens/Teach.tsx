import { useEffect, useState } from "react";
import { TEACH_MODE_MAX_SECONDS } from "@maman/contracts";
import {
  describeCostCeiling,
  estimateSessionCost,
  SHIPPED_VISION_DEFAULTS,
} from "@maman/teach-mode";
import { visionSessionPrice } from "@maman/model-provider";
import { APP_PRESETS, useSettings } from "../../state/settings.js";
import { useTeach } from "../../state/teach.js";
import { onTeachObservation, onTeachStatus, secondsRemaining } from "../../lib/teachMode.js";
import { Button, Card, Muted, SectionTitle, StatusPill } from "../ui.js";

/**
 * Teach Mode: the user demonstrates a workflow, and Maman says what it thinks it
 * saw so they can correct it.
 *
 * Three things this screen is built to make unavoidable rather than discoverable:
 *
 * 1. IT SAYS WHAT IT DOES, WHERE THE BUTTON IS. This is the one feature that
 *    sends pictures of the screen off the device, so the sentence saying so sits
 *    next to Start rather than in Privacy where the toggle lives.
 * 2. NOTHING IS LEARNED UNTIL THE USER SAYS SO. Readings arrive `unreviewed` and
 *    are only written to the event store by an explicit Save.
 * 3. REFUSALS ARE VISIBLE. "Watching and learning nothing" is a state the user is
 *    entitled to understand, so every reason the gate withheld a frame is shown,
 *    with a count.
 */

/** Plain-language names for the gate's refusal reasons. */
const REASON_TEXT: Record<string, string> = {
  secure_field_focused: "a password field had focus — the whole frame was thrown away",
  private_browsing: "a private browsing window was in front",
  private_app: "an app you marked private was in front",
  hard_denied_app: "an always-off app (a password manager or keychain) was in front",
  out_of_session_scope: "you were in an app this session does not cover",
  too_much_would_be_masked: "too much of the screen would have needed blanking",
  paused: "observation is paused",
  session_expired: "the session's time was up",
  unknown_app: "the frontmost app could not be identified",
  window_unavailable: "that app had no window on screen",
  capture_failed: "the screenshot could not be taken",
  encode_failed: "the frame could not be prepared",
  no_session: "no session was running",
  screen_recording_permission_required:
    "macOS Screen Recording permission is not granted — grant it in System Settings",
  model_uncertain: "Maman could not tell what was happening",
  below_confidence_floor: "Maman was not confident enough to record a guess",
  no_actions: "nothing identifiable happened in that moment",
  invalid_output: "the reading did not make sense and was rejected whole",
  invalid_frame_metadata: "the frame's own details did not check out",
  inference_failed: "the vision request failed",
};

const DURATIONS = [
  { label: "2 min", seconds: 120 },
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "15 min", seconds: TEACH_MODE_MAX_SECONDS },
];

export function Teach({ onDone }: { onDone: () => void }) {
  const { settings, update } = useSettings();
  const teach = useTeach();
  const [scope, setScope] = useState<string[]>([]);
  const [duration, setDuration] = useState(300);
  const [now, setNow] = useState(Date.now());

  // The two channels the Rust core pushes on. Subscribed for the screen's life.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void onTeachStatus((p) => useTeach.getState().applyStatus(p)).then((f) => unsubs.push(f));
    void onTeachObservation((p) => useTeach.getState().applyObservation(p)).then((f) =>
      unsubs.push(f),
    );
    return () => unsubs.forEach((f) => f());
  }, []);

  // Drives the countdown. One second is the right resolution for a 15-minute box.
  useEffect(() => {
    if (teach.session.phase !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [teach.session.phase]);

  // What this session could cost, before the user authorises it. Derived from the
  // observer's real cadence and transport cap, not a guess — and a CEILING, since
  // identical frames are dropped before egress and refusals cost nothing.
  const price = visionSessionPrice(settings.vision_model_alias);
  const estimate = estimateSessionCost({
    ...SHIPPED_VISION_DEFAULTS,
    maxSeconds: duration,
    price,
  });

  const remaining = secondsRemaining(teach.session, teach.maxSeconds, now);
  const unreviewed = teach.readings.filter((r) => r.verdict === "unreviewed").length;
  const kept = teach.readings.filter((r) => r.verdict === "kept").length;

  // Apps the user already allowed for observation come first: demonstrating in an
  // app Maman may not otherwise watch is possible, but it is not the common case.
  const allowed = APP_PRESETS.filter((a) => settings.allowlist_bundles.includes(a.bundleId));
  const others = APP_PRESETS.filter((a) => !settings.allowlist_bundles.includes(a.bundleId));

  // THE CONSENT LIVES HERE, not behind a trip to Privacy.
  //
  // This used to be a dead end that said "Privacy → Teach Mode explains…",
  // which asked the user to leave, find a toggle, and come back — and most of
  // them arrived here having just been told Maman could not verify their
  // workflow, so the friction landed at exactly the wrong moment.
  //
  // What does NOT change: it is still off until they turn it on. Screen capture
  // is the one thing Maman does that leaves the device, `teach_session_start`
  // refuses without this setting, and a Rust test pins the default to OFF so a
  // missing settings file can never be the reason capture becomes possible.
  // Moving a decision closer to where it is made is not the same as making it
  // for them.
  if (!settings.teach_mode_enabled) {
    return (
      <div className="card border-warning/40 bg-warning/5 p-3">
        <div className="flex items-start justify-between gap-2">
          <SectionTitle>Showing Maman means letting it see your screen</SectionTitle>
          <StatusPill tone="muted">off</StatusPill>
        </div>
        <Muted>
          This is the one part of Maman that sends pictures of your screen to Anthropic. Frames go
          only while a session you started is running, only from the apps you pick, and only after
          credential-shaped areas are masked on this device. They are never stored, never synced,
          and never logged — only what Maman worked out from them is kept, and you review that
          before anything is learned.
        </Muted>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => void update({ teach_mode_enabled: true })}>
            Turn it on for this
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Not now
          </Button>
        </div>
        <Muted>
          Privacy → Teach Mode has the full detail, including everything a frame is refused for.
        </Muted>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {teach.session.phase === "idle" && (
        <Card>
          <SectionTitle>Show Maman how you do something</SectionTitle>
          <Muted>
            Do the workflow once while this runs. Maman watches the apps you pick, works out what
            you did, and then asks you to confirm it read things correctly — it can be wrong, so
            nothing is learned until you say so.
          </Muted>
          {/* Next to the button, not buried in Privacy: this is the moment the user
              decides, so it is the moment that has to be honest. */}
          <p className="mt-2 text-[11px] text-warning">
            While a session runs, pictures of the apps you pick are sent to Anthropic. Passwords,
            card numbers, keys and one-time codes are blanked out first, and a frame is thrown away
            entirely if a password field has focus. Frames are never saved to disk.
          </p>

          <p className="mt-3 text-xs font-medium text-ink">Which apps will you use?</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {[...allowed, ...others].map((app) => {
              const on = scope.includes(app.bundleId);
              return (
                <Button
                  key={app.bundleId}
                  variant={on ? "primary" : "secondary"}
                  onClick={() =>
                    setScope(
                      on ? scope.filter((b) => b !== app.bundleId) : [...scope, app.bundleId],
                    )
                  }
                >
                  {app.label}
                </Button>
              );
            })}
          </div>
          <Muted>
            Anything else on screen is not captured — not masked, not captured. Starting a session
            in one app is not permission to watch the rest.
          </Muted>

          <p className="mt-3 text-xs font-medium text-ink">For how long?</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {DURATIONS.map((d) => (
              <Button
                key={d.seconds}
                variant={duration === d.seconds ? "primary" : "secondary"}
                onClick={() => setDuration(d.seconds)}
              >
                {d.label}
              </Button>
            ))}
          </div>
          <Muted>It stops itself when the time is up. There is no always-on mode.</Muted>

          {/* The spend, before the button. Someone authorising a model call is
              entitled to know its size, and "vision is not cheap" is not a number. */}
          <p className="mt-2 text-[11px] text-muted">
            Model cost: {describeCostCeiling(estimate)}.
            {estimate.maxCostUsd > 0 && (
              <>
                {" "}
                Most sessions cost well under this — moments that look identical are not sent twice,
                and anything the privacy rules withhold costs nothing.
              </>
            )}
          </p>

          <div className="mt-3">
            <Button disabled={scope.length === 0} onClick={() => void teach.start(scope, duration)}>
              Start showing Maman
            </Button>
            {scope.length === 0 && (
              <span className="ml-2 text-[11px] text-muted">pick at least one app first</span>
            )}
          </div>
        </Card>
      )}

      {teach.session.phase === "starting" && <Muted>Starting the session…</Muted>}

      {teach.session.phase === "refused" && (
        <Card className="border-danger/40 bg-danger/5">
          <SectionTitle>Could not start</SectionTitle>
          <p className="text-xs text-danger">
            {REASON_TEXT[teach.session.reason] ?? teach.session.reason}
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => teach.reset()}>
              Back
            </Button>
          </div>
        </Card>
      )}

      {teach.session.phase === "recording" && (
        <Card className="border-warning/40 bg-warning/5">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle>Watching — go ahead and do the workflow</SectionTitle>
            <StatusPill tone="warning">{formatRemaining(remaining)} left</StatusPill>
          </div>
          <Muted>
            Sending pictures of {teach.session.scope.length} app
            {teach.session.scope.length === 1 ? "" : "s"} to Anthropic. It stops on its own when the
            time is up.
          </Muted>
          <p className="mt-2 text-xs text-ink tabular-nums">
            {teach.readings.length} thing{teach.readings.length === 1 ? "" : "s"} noticed ·{" "}
            {teach.framesRead} moment{teach.framesRead === 1 ? "" : "s"} read
            {teach.spend.frames > 0 && (
              <>
                {" · "}
                {teach.spend.costUsd < 0.01
                  ? "under $0.01 so far"
                  : `$${teach.spend.costUsd.toFixed(2)} so far`}
              </>
            )}
          </p>
          <div className="mt-2">
            <Button onClick={() => void teach.stop()}>Stop</Button>
          </div>
        </Card>
      )}

      {teach.session.phase === "ended" && (
        <Card>
          <SectionTitle>Session finished</SectionTitle>
          <Muted>
            {teach.session.reason === "time_box_elapsed"
              ? "The time was up, so it stopped itself."
              : "Stopped."}{" "}
            Nothing has been learned yet — check the readings below first.
          </Muted>
        </Card>
      )}

      {/* THE REVIEW. Teach Mode's readings can be wrong, so the person who did the
          work decides which ones count. */}
      {teach.readings.length > 0 && (
        <Card>
          <div className="flex items-center justify-between gap-2">
            <SectionTitle>What Maman thinks it saw</SectionTitle>
            <StatusPill tone={unreviewed > 0 ? "primary" : "success"}>
              {unreviewed > 0 ? `${unreviewed} to check` : "all reviewed"}
            </StatusPill>
          </div>
          <Muted>Keep what is right, discard what is not. Only what you keep is remembered.</Muted>
          <ul className="mt-2 space-y-1">
            {teach.readings.map((r) => (
              <li
                key={r.id}
                className="flex items-start justify-between gap-2 rounded border border-line p-1.5"
              >
                <div className="min-w-0">
                  <p className="text-xs text-ink">
                    Maman thinks you {r.description}
                    {r.seenCount > 1 && <span className="text-muted"> · seen {r.seenCount}×</span>}
                  </p>
                  <p className="text-[11px] text-muted tabular-nums break-all">
                    {Math.round(r.confidence * 100)}% sure · {r.token}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {r.verdict === "unreviewed" ? (
                    <>
                      <Button onClick={() => teach.setVerdict(r.id, "kept")}>Right</Button>
                      <Button
                        variant="secondary"
                        onClick={() => teach.setVerdict(r.id, "discarded")}
                      >
                        Wrong
                      </Button>
                    </>
                  ) : (
                    <StatusPill tone={r.verdict === "kept" ? "success" : "muted"}>
                      {r.verdict === "kept" ? "kept" : "discarded"}
                    </StatusPill>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            {unreviewed > 0 && (
              <>
                <Button variant="secondary" onClick={() => teach.keepAll()}>
                  All of it is right
                </Button>
                <Button variant="ghost" onClick={() => teach.discardAll()}>
                  Discard the rest
                </Button>
              </>
            )}
            {teach.session.phase !== "recording" && (
              <Button disabled={kept === 0} onClick={() => void teach.saveKept()}>
                Remember {kept} thing{kept === 1 ? "" : "s"}
              </Button>
            )}
          </div>
          {teach.saved !== null && (
            <p className="mt-1 text-[11px] text-success">
              {teach.saved === 0
                ? "Nothing kept, so nothing was remembered."
                : `Remembered ${teach.saved} — they count as observed work from now on.`}
            </p>
          )}
          {teach.error && <p className="mt-1 text-[11px] text-danger">{teach.error}</p>}
        </Card>
      )}

      {/* Why frames produced nothing. Shown at every phase, because during a
          session it is the difference between "working" and "silently doing
          nothing", and afterwards it explains a thin set of readings. */}
      {teach.skips.length > 0 && (
        <Card>
          <SectionTitle>Moments Maman did not use</SectionTitle>
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
            {teach.skips.map((s) => (
              <li key={s.reason}>
                · {REASON_TEXT[s.reason] ?? s.reason}
                {s.count > 1 && ` (${s.count}×)`}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(teach.session.phase === "ended" || teach.saved !== null) && (
        <div>
          <Button variant="secondary" onClick={() => teach.reset()}>
            Show Maman something else
          </Button>
        </div>
      )}
    </div>
  );
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
