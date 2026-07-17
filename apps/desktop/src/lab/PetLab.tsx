import { useEffect, useMemo, useRef, useState } from "react";
import {
  ANIMATIONS,
  ATLAS,
  mamanAnimationMap,
  spriteVersionNumber,
  type MamanAnimationState,
} from "../pet/atlas.js";
import { SpriteMaman } from "../pet/SpriteMaman.js";
import { gazeFrameForAngle } from "../pet/gaze.js";
import { initialConditions, resolvePetState, type PetConditions } from "../pet/machine.js";
import atlasUrl from "../pet/assets/maman-atlas.webp";

/**
 * Pet Lab — developer-only inspection surface for the spritesheet animation
 * system: every state, live row/frame/duration, playback controls, reduced
 * motion, simulated gaze, priority conflicts, the full atlas, and the sprite
 * at 72/96/112px on light and dark backgrounds.
 */

const STATES = Object.keys(mamanAnimationMap) as MamanAnimationState[];

const DEMO_SEQUENCE: Array<{ state: MamanAnimationState; ms: number }> = [
  { state: "idle", ms: 2500 },
  { state: "looking_around", ms: 3000 },
  { state: "waving", ms: 2500 },
  { state: "waiting", ms: 2500 },
  { state: "working", ms: 2500 },
  { state: "reviewing", ms: 2500 },
  { state: "success", ms: 2500 },
  { state: "failed", ms: 3000 },
  { state: "moving_left", ms: 2000 },
  { state: "moving_right", ms: 2000 },
  { state: "idle", ms: 2000 },
];

export function PetLab() {
  const [state, setState] = useState<MamanAnimationState>("idle");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [dark, setDark] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [gazeAngle, setGazeAngle] = useState<number | null>(null);
  const [frame, setFrame] = useState<{ row: number; column: number }>({ row: 0, column: 0 });
  const [demoRunning, setDemoRunning] = useState(false);
  const [restartKey, setRestartKey] = useState(0);
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Priority-conflict playground: toggle raw condition flags and see the
  // resolved state (only one state may ever render).
  const [flags, setFlags] = useState<PetConditions>({
    ...initialConditions,
    observationPaused: false,
  });

  const mapped = mamanAnimationMap[state];
  const def =
    mapped === "idle-sleep-frame" || mapped === "look-direction" ? null : ANIMATIONS[mapped];
  const duration =
    def && frame.row === def.row ? (def.durations[frame.column] ?? def.durations.at(-1)) : null;

  const gazeFrame = useMemo(
    () => (gazeAngle === null ? null : gazeFrameForAngle(gazeAngle)),
    [gazeAngle],
  );

  useEffect(() => {
    if (!demoRunning) return;
    let i = 0;
    const step = () => {
      if (i >= DEMO_SEQUENCE.length) {
        setDemoRunning(false);
        return;
      }
      const entry = DEMO_SEQUENCE[i]!;
      setState(entry.state);
      i += 1;
      demoTimer.current = setTimeout(step, entry.ms);
    };
    step();
    return () => {
      if (demoTimer.current) clearTimeout(demoTimer.current);
    };
  }, [demoRunning]);

  const bg = dark ? "#1E1F2A" : "#FAF8F4";
  const fg = dark ? "#F5F4FA" : "#20242A";

  return (
    <main
      style={{
        background: bg,
        color: fg,
        minHeight: "100vh",
        padding: 24,
        fontFamily: "ui-sans-serif",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>
        Maman Pet Lab{" "}
        <small style={{ opacity: 0.6 }}>spriteVersionNumber {spriteVersionNumber}</small>
      </h1>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 16 }}>
        {/* live sprite at three sizes */}
        <section>
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>Sprite (72 / 96 / 112 px)</h2>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginTop: 8 }}>
            {[72, 96, 112].map((size) => (
              <div key={`${size}-${restartKey}-${paused}`}>
                <SpriteMaman
                  state={state}
                  size={size}
                  reducedMotion={reducedMotion || paused}
                  ariaLabel={`Maman at ${size}px`}
                  gazeFrame={gazeFrame}
                  {...(size === 96 ? { onFrame: setFrame } : {})}
                />
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
            state=<b>{state}</b> → animation=<b>{mapped}</b>
            <br />
            row={frame.row} frame={frame.column}
            {duration !== null && ` duration=${duration}ms (×${speed})`}
          </p>
        </section>

        {/* controls */}
        <section style={{ minWidth: 260 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>States</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {STATES.map((s) => (
              <button
                key={s}
                onClick={() => setState(s)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  border: "1px solid #8884",
                  background: s === state ? "#4F46E5" : "transparent",
                  color: s === state ? "#fff" : fg,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>

          <h2 style={{ fontSize: 13, fontWeight: 600, marginTop: 16 }}>Playback</h2>
          <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
            <button onClick={() => setPaused((p) => !p)}>{paused ? "▶ Play" : "⏸ Pause"}</button>
            <button onClick={() => setRestartKey((k) => k + 1)}>↺ Restart</button>
            <label style={{ fontSize: 12 }}>
              speed{" "}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {[0.25, 0.5, 1, 2, 4].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 12, fontSize: 12 }}>
            <label>
              <input
                type="checkbox"
                checked={reducedMotion}
                onChange={(e) => setReducedMotion(e.target.checked)}
              />{" "}
              reduced motion
            </label>
            <label>
              <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />{" "}
              dark desktop
            </label>
          </div>
          <button
            onClick={() => setDemoRunning((r) => !r)}
            style={{
              marginTop: 12,
              padding: "6px 12px",
              borderRadius: 8,
              background: "#0F9F8F",
              color: "#fff",
              border: 0,
              cursor: "pointer",
            }}
          >
            {demoRunning ? "Stop demo sequence" : "Run demo sequence"}
          </button>

          <h2 style={{ fontSize: 13, fontWeight: 600, marginTop: 16 }}>Simulated gaze</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8, maxWidth: 260 }}>
            <button onClick={() => setGazeAngle(null)} style={{ fontSize: 11 }}>
              none (dead zone)
            </button>
            {Array.from({ length: 16 }, (_, i) => i * 22.5).map((a) => (
              <button
                key={a}
                onClick={() => setGazeAngle(a)}
                style={{
                  fontSize: 11,
                  background: gazeAngle === a ? "#4F46E5" : "transparent",
                  color: gazeAngle === a ? "#fff" : fg,
                  border: "1px solid #8884",
                  borderRadius: 6,
                  padding: "2px 6px",
                  cursor: "pointer",
                }}
              >
                {a}°
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Gaze applies in idle / looking_around only (engagement-gated in production).
          </p>
        </section>

        {/* priority conflicts */}
        <section style={{ minWidth: 220 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>State-priority conflicts</h2>
          <p style={{ fontSize: 11, opacity: 0.7 }}>Toggle flags — one state always wins.</p>
          {(Object.keys(flags) as Array<keyof PetConditions>).map((key) => (
            <label key={key} style={{ display: "block", fontSize: 12, marginTop: 4 }}>
              <input
                type="checkbox"
                checked={flags[key]}
                onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
              />{" "}
              {key}
            </label>
          ))}
          <p style={{ fontSize: 13, marginTop: 8 }}>
            resolves to <b>{resolvePetState(flags)}</b>{" "}
            <button
              onClick={() => setState(resolvePetState(flags))}
              style={{ fontSize: 11, marginLeft: 6 }}
            >
              apply
            </button>
          </p>
        </section>
      </div>

      {/* full atlas */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600 }}>
          Atlas ({ATLAS.width}×{ATLAS.height}, {ATLAS.columns}×{ATLAS.rows} @ {ATLAS.cellWidth}×
          {ATLAS.cellHeight})
        </h2>
        <img
          src={atlasUrl}
          alt="Full Maman spritesheet atlas"
          style={{
            width: ATLAS.width / 2,
            imageRendering: "pixelated",
            background: dark ? "#2A2B3A" : "#EFEBE2",
            marginTop: 8,
          }}
        />
      </section>
    </main>
  );
}
