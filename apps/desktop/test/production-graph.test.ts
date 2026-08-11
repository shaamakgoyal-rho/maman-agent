import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE PRODUCTION GRAPH CANNOT REACH DEMO CODE.
 *
 * Demo fixtures used to sit on the main product surface: `Home.tsx` imported
 * six generators from `@maman/demo-fixtures` and rendered six seeding buttons,
 * so synthetic runs were one click from the same screen that reports what Maman
 * genuinely observed. A comment claiming separation is not separation — this
 * test walks the real import graph from the production entry points and fails if
 * demo code is reachable at all.
 *
 * It is deliberately a SOURCE-GRAPH test, not a mocked one: it resolves relative
 * imports from `panel/main.tsx` (the panel entry) and follows them transitively,
 * which is the same reachability a bundler computes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");

/** Entry points that ship in the production panel bundle. */
const ENTRIES = ["panel/main.tsx", "pet/main.tsx", "statusbar/main.tsx"];

/**
 * KNOWN, NAMED DEBT — a ratchet, not an exemption.
 *
 * `lib/runs.ts` holds two unrelated things in one module: the demo Salesforce
 * arcs AND the real browser-lane run store (`useRuns`: browserPlan, diff,
 * approve) that the Agents screen's approval UI still depends on. Splitting the
 * module is the fix; until then this file is the ONLY tolerated path from
 * production to demo symbols, and it is listed here so the test still fails the
 * moment any *other* file reaches demo code.
 *
 * Do not add entries to loosen a failure. Split the module instead.
 */
const KNOWN_DEBT = ["lib/runs.ts"];

/** Anything that fabricates activity, models, or receipts. */
const FORBIDDEN = [
  "@maman/demo-fixtures",
  "DemoModelProvider",
  "demoAdapterRegistry",
  "DemoSalesforceWorld",
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;'"]*?["']([^"']+)["']/g;

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  // Internal packages and this app compile TS directly; ".js" specifiers in
  // source resolve to the ".ts"/".tsx" file on disk.
  const candidates = base.endsWith(".js")
    ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base]
    : [`${base}.ts`, `${base}.tsx`, base, resolve(base, "index.ts")];
  return candidates.find((c) => existsSync(c) && !c.endsWith("/")) ?? null;
}

/** Every production source file reachable from the entries, with its text. */
function reachableFiles(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = ENTRIES.map((e) => resolve(SRC, e)).filter((f) => existsSync(f));
  expect(queue.length, "no production entry points found — did paths move?").toBeGreaterThan(0);

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const match of text.matchAll(IMPORT_RE)) {
      const next = resolveModule(file, match[1]!);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe("the production desktop graph is free of demo machinery", () => {
  it("reaches no demo fixture, demo model, or demo adapter from any entry point", () => {
    const files = reachableFiles();
    const offenders: string[] = [];
    for (const [file, text] of files) {
      if (KNOWN_DEBT.some((debt) => file.endsWith(debt))) continue;
      for (const needle of FORBIDDEN) {
        // Only IMPORTS count: prose in a comment explaining why demo code is
        // absent must not fail the test that proves it.
        for (const match of text.matchAll(IMPORT_RE)) {
          const spec = match[1]!;
          if (spec.includes(needle)) offenders.push(`${file.replace(SRC, "src")} → ${spec}`);
        }
        if (new RegExp(`import[^;]*\\b${needle}\\b[^;]*from`).test(text)) {
          offenders.push(`${file.replace(SRC, "src")} imports ${needle}`);
        }
      }
    }
    expect(offenders, `demo code is reachable from production:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("keeps the creation path itself demo-free", () => {
    // The one authoritative creation function. Named explicitly because this is
    // the exact path a trigger takes to real execution.
    const text = readFileSync(resolve(SRC, "lib/agentService.ts"), "utf8");
    for (const needle of FORBIDDEN) {
      expect(new RegExp(`import[^;]*${needle}`).test(text), `agentService imports ${needle}`).toBe(
        false,
      );
    }
  });

  it("no longer ships the screens whose complexity this replaced", () => {
    // Deleted rather than orphaned: an unreferenced screen is dead code that the
    // next reader has to rule out, and reviving it is one import away.
    const screens = readdirSync(resolve(SRC, "panel/screens"));
    for (const gone of [
      "Home.tsx",
      "Suggestions.tsx",
      "Activity.tsx",
      "Settings.tsx",
      "Configure.tsx",
      "Teach.tsx",
    ]) {
      expect(screens, `${gone} should be gone from the primary product`).not.toContain(gone);
    }
    expect(screens).toContain("Mother.tsx");
  });

  it("the panel shell owns no background timer", () => {
    // Proactivity belongs to module-scope services (motherLoop) and the native
    // daemon, not to a component's lifetime.
    const app = readFileSync(resolve(SRC, "panel/App.tsx"), "utf8");
    expect(app).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("the known debt is exactly one module, and it is shrinking", () => {
  it("only lib/runs.ts reaches demo code, and only because the run store lives there", () => {
    // Pins the debt so it cannot silently grow: if a second module starts
    // importing demo code, the test above fails; if runs.ts stops needing it,
    // this test fails and KNOWN_DEBT should be emptied.
    const text = readFileSync(resolve(SRC, "lib/runs.ts"), "utf8");
    const stillNeeded = FORBIDDEN.filter((needle) =>
      new RegExp(`import[^;]*${needle}|\\b${needle}\\b`).test(text),
    );
    expect(stillNeeded.length, "runs.ts is clean — empty KNOWN_DEBT").toBeGreaterThan(0);
    expect(KNOWN_DEBT).toEqual(["lib/runs.ts"]);
  });
});
