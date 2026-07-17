/**
 * Visual design tokens. These are the locked v1 values from the product spec.
 * Consumed by Tailwind configs (desktop, web) and the pet renderer.
 */
export const colors = {
  background: "#FAF8F4",
  panel: "#FFFFFF",
  primary: "#4F46E5",
  primaryHover: "#4338CA",
  success: "#0F9F8F",
  warning: "#D97706",
  danger: "#DC5A5A",
  text: "#20242A",
  textMuted: "#667085",
  border: "#E7E2DA",
  focusRing: "#7C83FF",
} as const;

/** Pet body palette: indigo-to-lavender with cream face accents. */
export const petPalette = {
  bodyFrom: "#4F46E5",
  bodyTo: "#A5A6F6",
  face: "#FFF7EA",
  accent: "#0F9F8F",
  blush: "#F2B8B5",
} as const;

export const radii = {
  panel: "12px",
} as const;

export const fontStacks = {
  /** System San Francisco on macOS, Inter as the web fallback. */
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif',
} as const;

export const petWindow = {
  width: 112,
  height: 128,
  edgeSnapPx: 16,
  dragHoldMs: 300,
} as const;

export const panelWindow = {
  width: 420,
  height: 640,
} as const;
