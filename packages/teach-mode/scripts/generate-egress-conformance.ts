import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { TeachModeSession } from "@maman/contracts";
import { frameEgressDecision, type FrameContext, type TextRegion } from "../src/redact.js";

/**
 * Generates `domain/teach-egress-conformance.json` — the drift contract between
 * the TypeScript egress gate (the specification, `src/redact.ts`) and its Swift
 * mirror (`ObserverCore/TeachModeGate.swift`), which is the copy that actually
 * stands between a captured frame and the network.
 *
 * `expected` is produced by RUNNING the TS gate, never typed by hand: the fixture
 * pins both implementations to one behaviour, not both to a guess. Same pattern
 * as the classifier and date-extraction contracts.
 */

const SF = "com.google.Chrome";
const MAIL = "com.apple.mail";
const KEYCHAIN = "com.apple.keychainaccess";
const MAMAN = "com.maman.desktop";

function session(over: Partial<TeachModeSession> = {}): TeachModeSession {
  return {
    schema_version: 1,
    session_id: "018f0000-0000-7000-8000-0000000000e1",
    started_at: "2026-08-05T12:00:00.000Z",
    max_seconds: 300,
    scope_bundle_ids: [SF],
    ...over,
  };
}

function region(text: string, over: Partial<TextRegion> = {}): TextRegion {
  return { text, x: 12, y: 40, width: 180, height: 18, ...over };
}

function context(over: Partial<FrameContext> = {}): FrameContext {
  return {
    session: session(),
    bundleId: SF,
    elapsedSeconds: 10,
    paused: false,
    hardDeniedBundleIds: [KEYCHAIN],
    privateBundleIds: [MAMAN],
    privateBrowsing: false,
    secureFieldFocused: false,
    textRegions: [region("Close date"), region("Account Owner")],
    ...over,
  };
}

const CASES: Array<{ name: string; context: FrameContext }> = [
  { name: "clean frame from an in-scope app is sent unmasked", context: context() },
  {
    name: "no session refuses — capture is never implicit",
    context: (() => {
      const c = context();
      delete c.session;
      return c;
    })(),
  },
  { name: "elapsed time at the box refuses", context: context({ elapsedSeconds: 300 }) },
  { name: "one second inside the box still sends", context: context({ elapsedSeconds: 299 }) },
  { name: "paused refuses", context: context({ paused: true }) },
  {
    name: "unidentifiable app refuses",
    context: (() => {
      const c = context();
      delete c.bundleId;
      return c;
    })(),
  },
  { name: "whitespace bundle id refuses", context: context({ bundleId: "  " }) },
  { name: "hard-denied app refuses", context: context({ bundleId: KEYCHAIN }) },
  {
    name: "maman never films itself even when scoped to itself",
    context: context({ bundleId: MAMAN, session: session({ scope_bundle_ids: [MAMAN] }) }),
  },
  { name: "private browsing refuses", context: context({ privateBrowsing: true }) },
  {
    name: "focused secure field withholds the whole frame",
    context: context({ secureFieldFocused: true }),
  },
  { name: "out-of-scope app refuses", context: context({ bundleId: MAIL }) },
  {
    name: "many violations report one deterministic reason (ordering pin)",
    context: context({
      bundleId: KEYCHAIN,
      paused: true,
      privateBrowsing: true,
      secureFieldFocused: true,
      elapsedSeconds: 9999,
    }),
  },
  {
    name: "more mask than picture withholds the frame",
    context: context({
      textRegions: [region("api_key"), region("password"), region("token"), region("Close date")],
    }),
  },
  {
    name: "exactly the mask threshold still sends",
    context: context({ textRegions: [region("password"), region("Close date")] }),
  },
  { name: "a frame with no text sends", context: context({ textRegions: [] }) },
  {
    name: "os secure flag masks with secure_field even on an innocent label",
    context: context({
      textRegions: [region("Close date", { secure: true }), region("A"), region("B")],
    }),
  },
  {
    name: "secret-shaped values mask regardless of label",
    context: context({
      textRegions: [
        region("AKIAIOSFODNN7EXAMPLE"),
        region(`sk-ant-${"x".repeat(30)}`),
        region("-----BEGIN RSA PRIVATE KEY-----"),
        region(`xoxb-${"1".repeat(12)}`),
        region(`ghp_${"a".repeat(36)}`),
        region(`eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(8)}`),
        region("password: hunter2"),
        region("Ordinary one"),
        region("Ordinary two"),
        region("Ordinary three"),
        region("Ordinary four"),
        region("Ordinary five"),
        region("Ordinary six"),
        region("Ordinary seven"),
      ],
    }),
  },
  {
    name: "credential-shaped labels mask as unrecognised_credential_field",
    context: context({
      textRegions: [
        region("Confirm passphrase"),
        region("One-time code / OTP"),
        region("Recovery code"),
        region("Sort code"),
        region("Close date"),
        region("Account Owner"),
        region("Employees"),
        region("Annual revenue"),
        region("Invoice number"),
        region("Website"),
      ],
    }),
  },
  {
    name: "password manager ui masks as password_manager_ui",
    context: context({
      textRegions: [region("1Password suggestion"), region("A"), region("B")],
    }),
  },
  {
    name: "mask geometry is clamped away from zero area",
    context: context({
      textRegions: [
        region("password", { x: -5, y: -9, width: 0.4, height: 0 }),
        region("A"),
        region("B"),
      ],
    }),
  },
  {
    name: "reason precedence: secure flag beats a secret-shaped value",
    context: context({
      textRegions: [region("AKIAIOSFODNN7EXAMPLE", { secure: true }), region("A"), region("B")],
    }),
  },
  {
    name: "reason precedence: password manager beats a credential label",
    context: context({
      textRegions: [region("1Password — password"), region("A"), region("B")],
    }),
  },
];

function serializeContext(c: FrameContext) {
  return {
    session:
      c.session === undefined
        ? null
        : {
            session_id: c.session.session_id,
            max_seconds: c.session.max_seconds,
            scope_bundle_ids: c.session.scope_bundle_ids,
          },
    bundle_id: c.bundleId ?? null,
    elapsed_seconds: c.elapsedSeconds,
    paused: c.paused,
    hard_denied_bundle_ids: c.hardDeniedBundleIds,
    private_bundle_ids: c.privateBundleIds,
    private_browsing: c.privateBrowsing,
    secure_field_focused: c.secureFieldFocused,
    text_regions: c.textRegions.map((r) => ({
      text: r.text,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      secure: r.secure ?? false,
    })),
  };
}

export function buildFixture(): string {
  const cases = CASES.map(({ name, context: c }) => {
    const decision = frameEgressDecision(c);
    return {
      name,
      context: serializeContext(c),
      expected: decision.send
        ? { send: true, reason: null, masks: decision.masks }
        : { send: false, reason: decision.reason, masks: [] },
    };
  });
  return `${JSON.stringify(
    {
      _comment:
        "GENERATED by packages/teach-mode/scripts/generate-egress-conformance.ts — do not edit. " +
        "Drift contract between the TS frame-egress gate (redact.ts, the specification) and its " +
        "Swift mirror (TeachModeGate.swift, the copy that stands between captured pixels and the " +
        "network). Both languages assert every case; a missing fixture FAILS, never skips.",
      cases,
    },
    null,
    2,
  )}\n`;
}

const ROOT = join(import.meta.dirname, "..", "..", "..");
export const EGRESS_FIXTURE_PATH = join(ROOT, "domain", "teach-egress-conformance.json");

// Run the CLI only when executed directly. The conformance TEST imports
// `buildFixture` from this file, and a top-level write would mean the test
// silently REPAIRS a tampered fixture instead of failing on it — which is
// exactly what happened the first time the tamper drill was run.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly && process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(EGRESS_FIXTURE_PATH, "utf8");
  } catch {
    current = "";
  }
  if (current !== buildFixture()) {
    console.error(
      "✗ teach-egress-conformance.json is out of date — run `pnpm teach:egress-conformance`",
    );
    process.exit(1);
  }
  console.log(`✓ teach-egress-conformance.json up to date (${CASES.length} cases)`);
} else if (invokedDirectly) {
  writeFileSync(EGRESS_FIXTURE_PATH, buildFixture());
  console.log(`wrote ${EGRESS_FIXTURE_PATH} (${CASES.length} cases)`);
}
