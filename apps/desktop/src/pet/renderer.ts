import type { ReactElement } from "react";
import type { PetStateName } from "./machine.js";
import type { MamanAnimationState } from "./atlas.js";

/**
 * Pet rendering is centralized behind this interface. The sole renderer is the
 * pixel-art SpritesheetPetRenderer (Seedy, spriteVersionNumber 2).
 */
export type PetRenderProps = {
  /** Product state, plus renderer-level movement states while dragging. */
  state: MamanAnimationState;
  /** Rendered size in CSS pixels (readable from 72 to 112). */
  size: number;
  reducedMotion: boolean;
  /** Accessible description announced by screen readers. */
  ariaLabel: string;
  /** Directional gaze frame (rows 9–10) during pointer engagement. */
  gazeFrame?: { row: number; column: number } | null;
};

export interface PetRenderer {
  readonly id: string;
  render(props: PetRenderProps): ReactElement;
}

const registry = new Map<string, PetRenderer>();

export function registerPetRenderer(renderer: PetRenderer): void {
  registry.set(renderer.id, renderer);
}

export function getPetRenderer(id: string): PetRenderer {
  const renderer = registry.get(id);
  if (!renderer) throw new Error(`pet renderer not registered: ${id}`);
  return renderer;
}

/** Human copy for each state — used for accessibility and the panel status line. */
export const PET_STATE_DESCRIPTIONS: Record<PetStateName, string> = {
  sleeping: "Maman is asleep. Observation is paused or the current app is private.",
  idle: "Maman is resting. Nothing needs attention.",
  looking_around: "Maman is quietly observing the apps you allowed.",
  thinking: "Maman is thinking about a pattern it noticed.",
  waving: "Maman has one new suggestion for you.",
  waiting: "Maman is waiting for your approval.",
  working: "Maman is running an agent.",
  reviewing: "Maman is double-checking results.",
  success: "The agent run completed.",
  failed: "An agent run stopped safely and needs your attention.",
};

export const MOVEMENT_DESCRIPTIONS: Record<"moving_left" | "moving_right", string> = {
  moving_left: "Maman is moving to a new spot.",
  moving_right: "Maman is moving to a new spot.",
};

export function describeAnimationState(state: MamanAnimationState): string {
  if (state === "moving_left" || state === "moving_right") return MOVEMENT_DESCRIPTIONS[state];
  return PET_STATE_DESCRIPTIONS[state];
}
