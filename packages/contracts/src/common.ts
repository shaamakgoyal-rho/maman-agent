import { z } from "zod";

/**
 * Shared primitives for every cross-process contract.
 *
 * Rules (locked):
 * - UUID v7 identifiers
 * - ISO 8601 UTC timestamps
 * - schema_version integers
 * - snake_case over persisted and wire formats
 * - explicit sensitivity and source fields
 * - no arbitrary any/unknown payloads after parsing (all objects are strict)
 */

export const uuid = z.string().uuid();

/** ISO 8601 UTC timestamp — must end in Z; offsets are rejected. */
export const utcTimestamp = z
  .string()
  .datetime({ offset: false })
  .describe("ISO 8601 UTC timestamp");

export const schemaVersion1 = z.literal(1);

export const sensitivity = z.enum(["public", "internal", "confidential", "restricted"]);
export type Sensitivity = z.infer<typeof sensitivity>;

export const eventSource = z.enum([
  "macos_ax",
  "chrome",
  "salesforce",
  "google",
  "demo",
  /**
   * Actions derived from screen frames by a vision model during an explicit,
   * time-boxed Teach Mode session. A separate source because its provenance is
   * genuinely different: inferred rather than observed, and therefore droppable
   * below a confidence floor. See `teach-mode.ts`.
   */
  "teach_mode",
]);
export type EventSource = z.infer<typeof eventSource>;

export const appCategory = z.enum([
  "crm",
  "spreadsheet",
  "email",
  "calendar",
  "research",
  "messaging",
  "browser",
  "other",
]);
export type AppCategory = z.infer<typeof appCategory>;

export const riskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevel>;

export const capabilityRiskLevel = z.enum(["low", "medium", "high", "prohibited"]);
export type CapabilityRiskLevel = z.infer<typeof capabilityRiskLevel>;

/**
 * Generates a UUID v7 (time-ordered). Injectable time/randomness for
 * deterministic tests.
 */
export function uuidv7(opts?: { timestampMs?: number; random?: () => number }): string {
  const ts = opts?.timestampMs ?? Date.now();
  const rand = opts?.random ?? Math.random;
  const bytes = new Uint8Array(16);
  // 48-bit big-endian millisecond timestamp
  let t = ts;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  for (let i = 6; i < 16; i++) {
    bytes[i] = Math.floor(rand() * 256) & 0xff;
  }
  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Detects values that look like secrets and must never appear in specs or literals. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk_live_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S+/i,
];

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

/** A string literal that must never contain secret-shaped content. */
export const nonSecretString = z
  .string()
  .refine((v) => !looksLikeSecret(v), { message: "value matches a secret shape" });
