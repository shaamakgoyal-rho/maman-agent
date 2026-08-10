// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CapturedFrame, VisionAction } from "@maman/contracts";

// No Tauri in a test environment; the screen must render entirely without it.
vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => false,
  invokeCommand: vi.fn(),
  emitAppEvent: vi.fn().mockResolvedValue(undefined),
  onAppEvent: vi.fn().mockResolvedValue(() => {}),
  loadSettingsRaw: vi.fn().mockResolvedValue(null),
  saveSettingsRaw: vi.fn().mockResolvedValue(undefined),
  togglePanel: vi.fn(),
  hidePanel: vi.fn(),
  startPetDrag: vi.fn(),
  quitApp: vi.fn(),
}));

import { Teach } from "../src/panel/screens/Teach.js";
import { useTeach } from "../src/state/teach.js";
import { useSettings } from "../src/state/settings.js";

const FRAME_ID = "018f0000-0000-7000-8000-0000000000f1";
const SESSION_ID = "018f0000-0000-7000-8000-000000000001";

function frame(): CapturedFrame {
  return {
    schema_version: 1,
    frame_id: FRAME_ID,
    session_id: SESSION_ID,
    captured_at: "2026-08-06T12:00:00.000Z",
    bundle_id: "com.google.Chrome",
    app_category: "browser",
    width: 1400,
    height: 900,
    masked_regions: 1,
  };
}

function action(over: Partial<VisionAction> = {}): VisionAction {
  return {
    event_type: "value_committed",
    target_role: "field",
    semantic_type: "date",
    object_type: "opportunity",
    label: "Close date",
    confidence: 0.9,
    ...over,
  };
}

function observation(actions: VisionAction[], over: Record<string, unknown> = {}) {
  return {
    frame: frame(),
    observation: {
      schema_version: 1,
      frame_id: FRAME_ID,
      session_id: SESSION_ID,
      actions,
      uncertain: false,
      ...over,
    },
  };
}

function enableTeachMode(on: boolean) {
  useSettings.setState({
    settings: { ...useSettings.getState().settings, teach_mode_enabled: on },
  });
}

beforeEach(() => {
  useTeach.getState().reset();
  enableTeachMode(true);
});
afterEach(cleanup);

describe("the screen refuses to record until the user turns Teach Mode on", () => {
  it("still offers NO way to start while it is off", () => {
    // The property that matters, unchanged: screen capture is the one thing
    // Maman does that leaves the device, so nothing here can begin a session
    // until the user has said yes.
    enableTeachMode(false);
    render(<Teach onDone={() => {}} />);
    expect(screen.queryByText("Start showing Maman")).toBeNull();
  });

  it("asks for consent HERE instead of sending the user to Privacy", () => {
    // This used to be a dead end reading "Privacy → Teach Mode explains…",
    // which asked someone to leave, find a toggle, and come back — at the exact
    // moment they had just been told Maman could not verify their workflow.
    enableTeachMode(false);
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText("Turn it on for this")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
  });

  it("says what turning it on means before they turn it on", () => {
    enableTeachMode(false);
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText(/sends pictures of your screen to Anthropic/)).toBeTruthy();
    // The limits are part of the ask, not fine print discovered later.
    expect(screen.getByText(/never stored, never synced/)).toBeTruthy();
  });
});

describe("the setup step says what it does where the button is", () => {
  it("names the egress next to Start, not only in Privacy", () => {
    render(<Teach onDone={() => {}} />);
    // The one sentence a user must not be able to miss.
    expect(screen.getByText(/pictures of the apps you pick are sent to Anthropic/)).toBeTruthy();
    expect(screen.getByText(/thrown away entirely if a password field has focus/)).toBeTruthy();
  });

  it("cannot start without naming at least one app", () => {
    render(<Teach onDone={() => {}} />);
    const start = screen.getByText("Start showing Maman") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("pick at least one app first")).toBeTruthy();

    fireEvent.click(screen.getByText("Slack"));
    expect((screen.getByText("Start showing Maman") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the review step", () => {
  it("shows what Maman thinks it saw, and remembers nothing on its own", () => {
    useTeach.getState().applyObservation(observation([action()]));
    useTeach.setState({ session: { phase: "ended", sessionId: SESSION_ID, reason: "stopped" } });
    render(<Teach onDone={() => {}} />);

    expect(screen.getByText(/Maman thinks you filled in "Close date"/)).toBeTruthy();
    expect(screen.getByText("1 to check")).toBeTruthy();
    // Nothing is kept yet, so there is nothing to remember.
    expect((screen.getByText(/^Remember 0 things$/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps only what the user marks right", () => {
    useTeach
      .getState()
      .applyObservation(observation([action({ label: "Close date" }), action({ label: "Stage" })]));
    useTeach.setState({ session: { phase: "ended", sessionId: SESSION_ID, reason: "stopped" } });
    render(<Teach onDone={() => {}} />);

    const rights = screen.getAllByText("Right");
    fireEvent.click(rights[0]!);
    expect(screen.getByText("kept")).toBeTruthy();
    expect((screen.getByText(/^Remember 1 thing$/) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText("Wrong"));
    expect(screen.getByText("discarded")).toBeTruthy();
    expect(screen.getByText("all reviewed")).toBeTruthy();
  });

  it("shows a repeated sighting as one reading with a count", () => {
    // Three frames showing the same action must not read as three things to check.
    for (let i = 0; i < 3; i++) useTeach.getState().applyObservation(observation([action()]));
    useTeach.setState({ session: { phase: "ended", sessionId: SESSION_ID, reason: "stopped" } });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText("1 to check")).toBeTruthy();
    expect(screen.getByText(/seen 3×/)).toBeTruthy();
  });

  it("hides Remember while a session is still recording", () => {
    useTeach.getState().applyObservation(observation([action()]));
    useTeach.setState({
      session: {
        phase: "recording",
        sessionId: SESSION_ID,
        scope: ["com.google.Chrome"],
        startedAtMs: Date.now(),
      },
    });
    render(<Teach onDone={() => {}} />);
    expect(screen.queryByText(/^Remember/)).toBeNull();
  });
});

describe("refusals are legible, not silent", () => {
  it("explains a withheld frame in plain words", () => {
    useTeach.getState().applyStatus({ state: "frame_refused", detail: "secure_field_focused" });
    useTeach.getState().applyStatus({ state: "frame_refused", detail: "secure_field_focused" });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText("Moments Maman did not use")).toBeTruthy();
    expect(
      screen.getByText(/a password field had focus — the whole frame was thrown away \(2×\)/),
    ).toBeTruthy();
  });

  it("explains a missing macOS permission rather than showing a raw code", () => {
    useTeach
      .getState()
      .applyStatus({ state: "refused", detail: "screen_recording_permission_required" });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText(/Screen Recording permission is not granted/)).toBeTruthy();
  });

  it("falls back to the raw reason it does not have words for, rather than hiding it", () => {
    useTeach.getState().applyStatus({ state: "frame_refused", detail: "something_new_from_rust" });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText(/something_new_from_rust/)).toBeTruthy();
  });
});

describe("the recording step", () => {
  it("counts down and offers a stop", () => {
    useTeach.setState({
      session: {
        phase: "recording",
        sessionId: SESSION_ID,
        scope: ["com.google.Chrome"],
        startedAtMs: Date.now(),
      },
      maxSeconds: 300,
    });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText("5:00 left")).toBeTruthy();
    expect(screen.getByText(/Sending pictures of 1 app to Anthropic/)).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("says the session stopped itself when the time ran out", () => {
    useTeach.setState({
      session: { phase: "ended", sessionId: SESSION_ID, reason: "time_box_elapsed" },
    });
    render(<Teach onDone={() => {}} />);
    expect(screen.getByText(/The time was up, so it stopped itself/)).toBeTruthy();
    expect(screen.getByText(/Nothing has been learned yet/)).toBeTruthy();
  });
});
