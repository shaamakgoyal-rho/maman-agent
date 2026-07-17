import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ATLAS, framePosition, type MamanAnimationState } from "./atlas.js";
import { FrameScheduler, planForState } from "./scheduler.js";
import type { PetRenderer, PetRenderProps } from "./renderer.js";
import atlasUrl from "./assets/maman-atlas.webp";

/**
 * SpritesheetPetRenderer — the production Maman renderer.
 * Pixel-art atlas, nearest-neighbor scaling, deterministic TS frame scheduler
 * (no CSS keyframes). Gaze frames override the animation only while the user
 * is engaged; the base never rotates or skews.
 */

const CELL_ASPECT = ATLAS.cellHeight / ATLAS.cellWidth; // 208/192

export function spriteStyle(row: number, column: number, size: number): CSSProperties {
  const pos = framePosition(column, row);
  return {
    width: size,
    height: size * CELL_ASPECT,
    backgroundImage: `url(${atlasUrl})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: "800% 1100%",
    backgroundPositionX: pos.backgroundPositionX,
    backgroundPositionY: pos.backgroundPositionY,
    imageRendering: "pixelated",
    transformOrigin: "bottom center",
  };
}

export type SpriteMamanProps = {
  state: MamanAnimationState;
  size: number;
  reducedMotion: boolean;
  ariaLabel: string;
  /** Directional gaze override (rows 9–10); active only during engagement. */
  gazeFrame?: { row: number; column: number } | null;
  /** Pet Lab hook: observe every emitted frame. */
  onFrame?: (frame: { row: number; column: number }) => void;
};

export function SpriteMaman({
  state,
  size,
  reducedMotion,
  ariaLabel,
  gazeFrame,
  onFrame,
}: SpriteMamanProps) {
  const [frame, setFrame] = useState<{ row: number; column: number }>({ row: 0, column: 0 });
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const scheduler = useMemo(
    () =>
      new FrameScheduler((f) => {
        setFrame(f);
        onFrameRef.current?.(f);
      }),
    [],
  );

  const gazeActive =
    gazeFrame !== null &&
    gazeFrame !== undefined &&
    (state === "idle" || state === "looking_around");

  useEffect(() => {
    if (gazeActive) {
      // Engagement gaze: static authored look frame; scheduler stays silent.
      scheduler.cancel();
      return;
    }
    scheduler.play(planForState(state, reducedMotion));
    return () => scheduler.cancel();
  }, [scheduler, state, reducedMotion, gazeActive]);

  const shown = gazeActive ? gazeFrame! : frame;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-pet-state={state}
      data-sprite-row={shown.row}
      data-sprite-column={shown.column}
      className="maman-sprite"
      style={spriteStyle(shown.row, shown.column, size)}
    />
  );
}

export const spritesheetPetRenderer: PetRenderer = {
  id: "spritesheet-v2",
  render: (props: PetRenderProps) => (
    <SpriteMaman
      state={props.state}
      size={props.size}
      reducedMotion={props.reducedMotion}
      ariaLabel={props.ariaLabel}
      gazeFrame={props.gazeFrame ?? null}
    />
  ),
};
