import { describe, expect, it, vi } from "vitest";
import { createEnrollmentStore, type EnrollmentDeps } from "../src/state/enrollment.js";

/**
 * Unit tests for the enrollment state machine (M18 §1). The device token is
 * never surfaced here — only the device id + expiry are, exactly as the Rust
 * command returns. Failures surface honestly (never a silent success).
 */

function makeDeps(over: Partial<EnrollmentDeps> = {}): {
  deps: EnrollmentDeps;
  persisted: Array<Record<string, unknown>>;
} {
  const persisted: Array<Record<string, unknown>> = [];
  const deps: EnrollmentDeps = {
    invoke: async <T>(cmd: string) => {
      if (cmd === "device_enroll") {
        return {
          device_id: "dev-123",
          device_token_expires_at: "2026-08-01T00:00:00.000Z",
        } as T;
      }
      if (cmd === "device_enrolled") return true as T;
      if (cmd === "sync_now") return { uploaded: 3, deduped: 1, remaining: 0 } as T;
      return undefined as T;
    },
    resolveDevIdentity: async () => ({
      organization_id: "org-1",
      user_id: "user-1",
      role: "member",
    }),
    devicePublicId: async () => "019f0000-0000-7000-8000-000000000abc",
    persist: async (patch) => {
      persisted.push(patch);
    },
    available: () => true,
    ...over,
  };
  return { deps, persisted };
}

describe("enrollment state machine", () => {
  it("enroll surfaces only device id + expiry, and persists server_enabled", async () => {
    let enrollArgs: Record<string, unknown> | undefined;
    const { deps, persisted } = makeDeps({
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "device_enroll") {
          enrollArgs = args;
          return {
            device_id: "dev-123",
            device_token_expires_at: "2026-08-01T00:00:00.000Z",
          } as T;
        }
        return undefined as T;
      },
    });
    const store = createEnrollmentStore(deps);
    await store.getState().enroll();

    const s = store.getState();
    expect(s.phase).toBe("enrolled");
    expect(s.deviceId).toBe("dev-123");
    expect(s.tokenExpiresAt).toBe("2026-08-01T00:00:00.000Z");
    // No token field is exposed anywhere on the state.
    expect(JSON.stringify(s)).not.toContain("device_token");
    expect(persisted[0]).toMatchObject({ server_enabled: true, server_device_id: "dev-123" });
    // The device public id must be a UUID (the server rejects anything else).
    expect(enrollArgs?.devicePublicId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("enroll failure ends not_enrolled with an honest error", async () => {
    const { deps } = makeDeps({
      resolveDevIdentity: async () => {
        throw new Error("API not seeded");
      },
    });
    const store = createEnrollmentStore(deps);
    await store.getState().enroll();
    expect(store.getState().phase).toBe("not_enrolled");
    expect(store.getState().error).toContain("seeded");
  });

  it("syncNow records the outcome and last-sync time", async () => {
    const { deps, persisted } = makeDeps();
    const store = createEnrollmentStore(deps);
    await store.getState().syncNow();
    expect(store.getState().lastSync).toEqual({ uploaded: 3, deduped: 1, remaining: 0 });
    expect(persisted.some((p) => "server_last_sync_at" in p)).toBe(true);
  });

  it("a sync failure surfaces the error and stays enrolled (never a silent success)", async () => {
    const { deps } = makeDeps({
      invoke: async <T>(cmd: string) => {
        if (cmd === "sync_now") throw new Error("server 503");
        return undefined as T;
      },
    });
    const store = createEnrollmentStore(deps);
    await store.getState().syncNow();
    expect(store.getState().phase).toBe("enrolled");
    expect(store.getState().error).toContain("503");
    expect(store.getState().lastSync).toBeNull();
  });

  it("enrollment is unavailable (no keychain) in the web preview", async () => {
    const enrollSpy = vi.fn();
    const { deps } = makeDeps({ available: () => false, invoke: enrollSpy });
    const store = createEnrollmentStore(deps);
    await store.getState().enroll();
    expect(store.getState().error).toContain("desktop app");
    expect(enrollSpy).not.toHaveBeenCalled();
  });

  it("unenroll clears the token and disables server mode", async () => {
    const { deps, persisted } = makeDeps();
    const store = createEnrollmentStore(deps);
    await store.getState().enroll();
    await store.getState().unenroll();
    expect(store.getState().phase).toBe("not_enrolled");
    expect(store.getState().deviceId).toBeNull();
    expect(persisted.at(-1)).toMatchObject({ server_enabled: false, server_device_id: null });
  });
});
