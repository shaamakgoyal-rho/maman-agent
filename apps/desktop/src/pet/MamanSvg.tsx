import type { ReactElement } from "react";
import { petPalette } from "@maman/config";
import type { PetStateName } from "./machine.js";
import type { PetRenderer, PetRenderProps } from "./renderer.js";

/**
 * SVG fallback renderer. The production renderer is the pixel-art
 * SpritesheetPetRenderer (see SpriteMaman.tsx); this remains registered as a
 * fallback if the atlas asset fails to load.
 *
 * Maman — an original character. A small, round, soft-edged creature with two
 * antennae, expressive eyes, a cream face patch, and a little curled tail.
 * Error states change expression AND posture, never only color.
 * All motion respects reduced-motion.
 */

type Expression = {
  /** eye openness 0..1 (0 closed) */
  eyes: number;
  /** pupil x offset for glances */
  gaze: number;
  /** mouth: curve control (positive = smile, negative = frown) */
  mouth: number;
  /** antenna droop in degrees (positive = drooped/sad) */
  antennaDroop: number;
  /** whole-body tilt in degrees */
  tilt: number;
  /** body squash (1 = round, <1 = flattened for sleeping) */
  squash: number;
  brows?: "raised" | "knit";
  extras?: "zzz" | "dots" | "wave" | "sparkle" | "gears" | "magnifier";
};

const EXPRESSIONS: Record<PetStateName, Expression> = {
  sleeping: {
    eyes: 0,
    gaze: 0,
    mouth: 0.2,
    antennaDroop: 24,
    tilt: 0,
    squash: 0.86,
    extras: "zzz",
  },
  idle: { eyes: 1, gaze: 0, mouth: 0.35, antennaDroop: 0, tilt: 0, squash: 1 },
  looking_around: { eyes: 1, gaze: 1, mouth: 0.3, antennaDroop: 0, tilt: 2, squash: 1 },
  thinking: {
    eyes: 0.7,
    gaze: -0.6,
    mouth: 0.1,
    antennaDroop: -6,
    tilt: -3,
    squash: 1,
    extras: "dots",
  },
  waving: { eyes: 1, gaze: 0, mouth: 0.55, antennaDroop: -4, tilt: 4, squash: 1, extras: "wave" },
  waiting: { eyes: 1, gaze: 0, mouth: 0.15, antennaDroop: 4, tilt: 0, squash: 1, brows: "raised" },
  working: {
    eyes: 0.85,
    gaze: 0.3,
    mouth: 0.25,
    antennaDroop: -2,
    tilt: 0,
    squash: 1,
    extras: "gears",
  },
  reviewing: {
    eyes: 0.9,
    gaze: -0.3,
    mouth: 0.2,
    antennaDroop: 0,
    tilt: -2,
    squash: 1,
    extras: "magnifier",
  },
  success: {
    eyes: 1,
    gaze: 0,
    mouth: 0.8,
    antennaDroop: -8,
    tilt: 0,
    squash: 1.02,
    extras: "sparkle",
  },
  failed: { eyes: 0.55, gaze: 0, mouth: -0.5, antennaDroop: 34, tilt: -6, squash: 0.94 },
};

function Maman({ state, size, reducedMotion, ariaLabel }: PetRenderProps): ReactElement {
  // Movement states are spritesheet-only; the SVG fallback shows looking_around.
  const e =
    state === "moving_left" || state === "moving_right"
      ? EXPRESSIONS.looking_around
      : EXPRESSIONS[state];
  const animate = !reducedMotion;
  const eyeRy = 6.5 * e.eyes + 0.6;
  const pupilDx = e.gaze * 2.4;
  const mouthCurve = e.mouth * 10;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-pet-state={state}
      style={{ width: size, height: size * (128 / 112), position: "relative" }}
    >
      <svg
        viewBox="0 0 112 128"
        width="100%"
        height="100%"
        aria-hidden="true"
        style={{ overflow: "visible" }}
      >
        <defs>
          <radialGradient id="maman-body" cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor={petPalette.bodyTo} />
            <stop offset="100%" stopColor={petPalette.bodyFrom} />
          </radialGradient>
          <style>{`
            @keyframes maman-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.025); } }
            @keyframes maman-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.08); } }
            @keyframes maman-wave { 0%,100% { transform: rotate(0deg); } 40% { transform: rotate(-38deg); } 70% { transform: rotate(-10deg); } }
            @keyframes maman-dots { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
            @keyframes maman-glance { 0%,100% { transform: translateX(0); } 30% { transform: translateX(2.2px); } 65% { transform: translateX(-2.2px); } }
            @keyframes maman-gears { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .maman-anim-body { animation: maman-breathe 4.2s ease-in-out infinite; transform-origin: 56px 84px; }
            .maman-anim-eyes { animation: maman-blink 5.6s linear infinite; transform-origin: 56px 66px; }
            .maman-anim-glance { animation: maman-glance 6s ease-in-out infinite; }
            .maman-anim-wave { animation: maman-wave 1.6s ease-in-out infinite; transform-origin: 22px 74px; }
            .maman-anim-gears { animation: maman-gears 3.5s linear infinite; transform-origin: 92px 48px; }
            .maman-dot { animation: maman-dots 1.4s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) {
              .maman-anim-body, .maman-anim-eyes, .maman-anim-glance,
              .maman-anim-wave, .maman-anim-gears, .maman-dot { animation: none !important; }
            }
          `}</style>
        </defs>

        <g transform={`rotate(${e.tilt} 56 84)`}>
          {/* tail — a small curl at the lower right */}
          <path
            d="M 88 104 Q 100 108 98 96"
            fill="none"
            stroke={petPalette.bodyFrom}
            strokeWidth="6"
            strokeLinecap="round"
          />

          <g className={animate ? "maman-anim-body" : undefined}>
            {/* antennae — droop reflects mood (posture, not just color) */}
            <g transform={`rotate(${e.antennaDroop} 42 38)`}>
              <path
                d="M 42 40 Q 38 22 30 18"
                fill="none"
                stroke={petPalette.bodyFrom}
                strokeWidth="5"
                strokeLinecap="round"
              />
              <circle cx="29" cy="17" r="5" fill={petPalette.bodyTo} />
            </g>
            <g transform={`rotate(${-e.antennaDroop} 70 38)`}>
              <path
                d="M 70 40 Q 74 22 82 18"
                fill="none"
                stroke={petPalette.bodyFrom}
                strokeWidth="5"
                strokeLinecap="round"
              />
              <circle cx="83" cy="17" r="5" fill={petPalette.bodyTo} />
            </g>

            {/* body — soft round blob */}
            <ellipse cx="56" cy="84" rx="38" ry={38 * e.squash} fill="url(#maman-body)" />

            {/* cream face patch */}
            <ellipse cx="56" cy="76" rx="26" ry="20" fill={petPalette.face} opacity="0.95" />

            {/* blush */}
            <ellipse cx="38" cy="82" rx="5" ry="3" fill={petPalette.blush} opacity="0.8" />
            <ellipse cx="74" cy="82" rx="5" ry="3" fill={petPalette.blush} opacity="0.8" />

            {/* eyes */}
            <g className={animate && e.eyes > 0.5 ? "maman-anim-eyes" : undefined}>
              <g className={animate && e.gaze > 0.5 ? "maman-anim-glance" : undefined}>
                {e.eyes <= 0.05 ? (
                  <>
                    <path
                      d="M 42 70 Q 46 74 50 70"
                      fill="none"
                      stroke="#3B3E6B"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 62 70 Q 66 74 70 70"
                      fill="none"
                      stroke="#3B3E6B"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </>
                ) : (
                  <>
                    <ellipse cx="46" cy="70" rx="5" ry={eyeRy} fill="#3B3E6B" />
                    <ellipse cx="66" cy="70" rx="5" ry={eyeRy} fill="#3B3E6B" />
                    <circle cx={44.5 + pupilDx} cy={68 - e.eyes} r="1.6" fill="#FFFFFF" />
                    <circle cx={64.5 + pupilDx} cy={68 - e.eyes} r="1.6" fill="#FFFFFF" />
                  </>
                )}
              </g>
            </g>

            {/* brows */}
            {e.brows === "raised" && (
              <>
                <path
                  d="M 40 59 Q 46 55 52 58"
                  fill="none"
                  stroke="#3B3E6B"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M 60 58 Q 66 55 72 59"
                  fill="none"
                  stroke="#3B3E6B"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </>
            )}

            {/* mouth */}
            <path
              d={`M 49 ${88 - mouthCurve * 0.2} Q 56 ${88 + mouthCurve} 63 ${88 - mouthCurve * 0.2}`}
              fill="none"
              stroke="#3B3E6B"
              strokeWidth="2.5"
              strokeLinecap="round"
            />

            {/* waving arm */}
            {e.extras === "wave" && (
              <g className={animate ? "maman-anim-wave" : undefined}>
                <path
                  d="M 24 76 Q 12 66 10 54"
                  fill="none"
                  stroke={petPalette.bodyFrom}
                  strokeWidth="7"
                  strokeLinecap="round"
                />
                <circle cx="10" cy="52" r="5.5" fill={petPalette.bodyTo} />
              </g>
            )}
          </g>

          {/* state extras */}
          {e.extras === "zzz" && (
            <g fill="#8B90D9" fontFamily="sans-serif" fontWeight="700">
              <text x="84" y="44" fontSize="14" className={animate ? "maman-dot" : undefined}>
                z
              </text>
              <text
                x="93"
                y="32"
                fontSize="11"
                className={animate ? "maman-dot" : undefined}
                style={{ animationDelay: "0.4s" }}
              >
                z
              </text>
              <text
                x="100"
                y="23"
                fontSize="8"
                className={animate ? "maman-dot" : undefined}
                style={{ animationDelay: "0.8s" }}
              >
                z
              </text>
            </g>
          )}
          {e.extras === "dots" && (
            <g fill="#8B90D9">
              <circle cx="86" cy="42" r="3" className={animate ? "maman-dot" : undefined} />
              <circle
                cx="95"
                cy="34"
                r="4"
                className={animate ? "maman-dot" : undefined}
                style={{ animationDelay: "0.3s" }}
              />
              <circle
                cx="105"
                cy="25"
                r="5"
                className={animate ? "maman-dot" : undefined}
                style={{ animationDelay: "0.6s" }}
              />
            </g>
          )}
          {e.extras === "sparkle" && (
            <g fill={petPalette.accent}>
              <path d="M 90 34 l 2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5 z" />
              <path
                d="M 20 40 l 1.8 4.2 4.2 1.8 -4.2 1.8 -1.8 4.2 -1.8 -4.2 -4.2 -1.8 4.2 -1.8 z"
                opacity="0.8"
              />
            </g>
          )}
          {e.extras === "gears" && (
            <g className={animate ? "maman-anim-gears" : undefined} fill="#8B90D9">
              <circle
                cx="92"
                cy="48"
                r="4"
                fill="none"
                stroke="#8B90D9"
                strokeWidth="2.5"
                strokeDasharray="3 2.2"
              />
            </g>
          )}
          {e.extras === "magnifier" && (
            <g stroke="#8B90D9" strokeWidth="2.5" fill="none">
              <circle cx="92" cy="46" r="6" />
              <path d="M 96.5 50.5 L 103 57" strokeLinecap="round" />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}

export const svgPetRenderer: PetRenderer = {
  id: "svg-v1",
  render: (props) => <Maman {...props} />,
};
