// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// Mock the platform bridge so interactions are observable without Tauri.
const togglePanel = vi.fn();
const startPetDrag = vi.fn();
vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => false,
  invokeCommand: vi.fn(),
  emitAppEvent: vi.fn().mockResolvedValue(undefined),
  onAppEvent: vi.fn().mockResolvedValue(() => {}),
  loadSettingsRaw: vi.fn().mockResolvedValue(null),
  saveSettingsRaw: vi.fn().mockResolvedValue(undefined),
  togglePanel: (...args: unknown[]) => togglePanel(...args),
  hidePanel: vi.fn(),
  startPetDrag: (...args: unknown[]) => startPetDrag(...args),
  quitApp: vi.fn(),
}));

import { PetApp } from "../src/pet/PetApp.js";

// jsdom does not implement matchMedia; PetApp uses it for reduced-motion.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  togglePanel.mockClear();
  startPetDrag.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function petSurface() {
  const { container } = render(<PetApp />);
  return container.firstElementChild as HTMLElement;
}

describe("pet interactions (acceptance 15, 16)", () => {
  it("a plain click opens the panel", () => {
    const surface = petSurface();
    fireEvent.pointerDown(surface);
    vi.advanceTimersByTime(100); // released before the 300ms drag hold
    fireEvent.pointerUp(surface);
    expect(togglePanel).toHaveBeenCalledTimes(1);
    expect(startPetDrag).not.toHaveBeenCalled();
  });

  it("holding 300ms starts dragging and dragging cancels click-to-open", () => {
    const surface = petSurface();
    fireEvent.pointerDown(surface);
    vi.advanceTimersByTime(300); // hold threshold reached
    expect(startPetDrag).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(surface);
    expect(togglePanel).not.toHaveBeenCalled();
  });

  it("keyboard Enter opens the panel (keyboard path always available)", () => {
    const surface = petSurface();
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(togglePanel).toHaveBeenCalledTimes(1);
  });

  it("renders the sprite with an accessible name and state", () => {
    const surface = petSurface();
    const sprite = surface.querySelector('[role="img"]')!;
    expect(sprite.getAttribute("aria-label")).toBeTruthy();
    expect(sprite.getAttribute("data-pet-state")).toBe("sleeping"); // observation defaults off
    expect(sprite.getAttribute("data-sprite-row")).toBe("0");
    expect(sprite.getAttribute("data-sprite-column")).toBe("2"); // calm closed-eye frame
  });
});
