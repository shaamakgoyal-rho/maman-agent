import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestDefinition as manifest } from "../manifest.config.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("Manifest V3 validation", () => {
  it("is manifest_version 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("uses a module service worker, not a background page", () => {
    expect(manifest.background && "service_worker" in manifest.background).toBe(true);
  });

  it("requests only the minimal permissions", () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ["activeTab", "nativeMessaging", "scripting", "storage"].sort(),
    );
  });

  it("hosts are optional (per-domain runtime grants), never blanket", () => {
    expect((manifest as Record<string, unknown>)["host_permissions"] ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
  });

  it("declares no statically injected content scripts (registration is per-domain)", () => {
    expect((manifest as Record<string, unknown>)["content_scripts"] ?? []).toEqual([]);
  });

  it("contains no remotely hosted code references", () => {
    const json = JSON.stringify(manifest);
    expect(json).not.toMatch(/https?:\/\/[^"]*\.js/);
  });
});

describe("no keystroke path exists in the extension source", () => {
  it("no keydown/keyup/keypress listeners anywhere", () => {
    const srcDir = join(here, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of walk(srcDir)) {
      if (!/\.(ts|html)$/.test(file)) continue;
      const content = readFileSync(file, "utf8");
      expect(content, `${file} must not listen to key events`).not.toMatch(
        /keydown|keyup|keypress/,
      );
    }
  });
});
