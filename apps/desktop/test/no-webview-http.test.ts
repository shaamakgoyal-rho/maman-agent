import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard (M18.1): the desktop WEBVIEW must never talk HTTP. The Tauri
 * CSP (`connect-src 'self' ipc: http://ipc.localhost`) blocks any direct API
 * call, so all device→server HTTP originates in the Rust core and is reached via
 * `invokeCommand`. This test fails if a `fetch(`/`XMLHttpRequest`/`axios` or an
 * absolute API URL creeps back into `apps/desktop/src` — the exact regression
 * that broke enrollment + connectors. (The ESLint rule enforces the same thing;
 * this keeps the invariant covered even if lint config drifts.)
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip line + block comments so prose mentioning http/fetch does not trip us. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("desktop webview never talks HTTP (M18.1)", () => {
  const files = walk(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("has no fetch(/XMLHttpRequest/axios and no absolute http URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bfetch\s*\(/.test(code)) offenders.push(`${file}: fetch(`);
      if (/\bXMLHttpRequest\b/.test(code)) offenders.push(`${file}: XMLHttpRequest`);
      if (/from\s+["']axios["']/.test(code)) offenders.push(`${file}: import axios`);
      // Absolute http(s) URLs in code (the API origin regression). The only
      // allowed absolute reference is the CSP's ipc.localhost, which lives in
      // src-tauri config, not here.
      if (/["'`]https?:\/\/(?!ipc\.localhost)/.test(code)) {
        offenders.push(`${file}: absolute http(s) URL`);
      }
    }
    expect(offenders, `webview must route HTTP through Rust:\n${offenders.join("\n")}`).toEqual([]);
  });
});
