import { create } from "zustand";
import { uuidv7 } from "@maman/contracts";
import { invokeCommand, isTauri } from "../lib/bridge.js";
import { useSettings } from "./settings.js";

/**
 * Maman server enrollment state (M18 §1).
 *
 * Enrollment exchanges an authenticated USER session for a scoped device token.
 * That token lives ONLY in the OS keychain, attached to every device→server
 * call by the Rust core — it never reaches this webview. Here we surface only
 * the device id, token expiry, and last-sync status, and we drive enroll / sync
 * / unenroll through Tauri commands. Local-only mode keeps working with no
 * enrollment: nothing on this screen is required to use Maman.
 *
 * Dev auth (local trials): the org + owner user come from the seeded demo org.
 * They are resolved by the RUST core (the `resolve_dev_identity` command) — the
 * webview never talks HTTP to the API (the Tauri CSP forbids it; all
 * device→server HTTP originates in Rust). The WorkOS bearer path is left for
 * hosted deployments.
 */

export type EnrollmentDeps = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** Resolves the dev identity (org + owner user) for local enrollment. */
  resolveDevIdentity: () => Promise<{ organization_id: string; user_id: string; role: string }>;
  /** Returns a STABLE per-device public id (UUID), generating + persisting once. */
  devicePublicId: () => Promise<string>;
  /** Persists the display-only enrollment fields to local settings. */
  persist: (patch: {
    server_enabled?: boolean;
    server_device_public_id?: string | null;
    server_device_id?: string | null;
    server_token_expires_at?: string | null;
    server_last_sync_at?: string | null;
  }) => Promise<void>;
  available: () => boolean;
};

/** Resolves the dev identity through the Rust core (never a webview fetch). */
async function resolveDevIdentityViaRust(): Promise<{
  organization_id: string;
  user_id: string;
  role: string;
}> {
  return invokeCommand<{ organization_id: string; user_id: string; role: string }>(
    "resolve_dev_identity",
  );
}

/** Reads the stable device public id from settings, generating + persisting once. */
async function stableDevicePublicId(): Promise<string> {
  const store = useSettings.getState();
  const existing = store.settings.server_device_public_id;
  if (existing) return existing;
  const id = uuidv7();
  await store.update({ server_device_public_id: id });
  return id;
}

export const defaultEnrollmentDeps: EnrollmentDeps = {
  invoke: invokeCommand,
  resolveDevIdentity: resolveDevIdentityViaRust,
  devicePublicId: stableDevicePublicId,
  persist: (patch) => useSettings.getState().update(patch),
  available: isTauri,
};

export type EnrollmentPhase = "unknown" | "enrolling" | "enrolled" | "not_enrolled" | "syncing";

export type EnrollmentState = {
  phase: EnrollmentPhase;
  deviceId: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSync: { uploaded: number; deduped: number; remaining: number } | null;
  error: string | null;
  refresh: () => Promise<void>;
  enroll: () => Promise<void>;
  syncNow: () => Promise<void>;
  unenroll: () => Promise<void>;
};

export function createEnrollmentStore(deps: EnrollmentDeps) {
  return create<EnrollmentState>((set) => ({
    phase: "unknown",
    deviceId: null,
    tokenExpiresAt: null,
    lastSyncAt: null,
    lastSync: null,
    error: null,

    refresh: async () => {
      if (!deps.available()) {
        set({ phase: "not_enrolled" });
        return;
      }
      try {
        const enrolled = await deps.invoke<boolean>("device_enrolled");
        const s = useSettings.getState().settings;
        set({
          phase: enrolled ? "enrolled" : "not_enrolled",
          deviceId: enrolled ? s.server_device_id : null,
          tokenExpiresAt: enrolled ? s.server_token_expires_at : null,
          lastSyncAt: s.server_last_sync_at,
          error: null, // a successful refresh clears any stale prior error
        });
      } catch (e) {
        set({ phase: "not_enrolled", error: e instanceof Error ? e.message : String(e) });
      }
    },

    enroll: async () => {
      if (!deps.available()) {
        set({ error: "Enrollment requires the desktop app (web preview has no keychain)." });
        return;
      }
      set({ phase: "enrolling", error: null });
      try {
        const id = await deps.resolveDevIdentity();
        const devicePublicId = await deps.devicePublicId();
        const result = await deps.invoke<{ device_id: string; device_token_expires_at: string }>(
          "device_enroll",
          {
            auth: {
              mode: "dev",
              organization_id: id.organization_id,
              user_id: id.user_id,
              role: id.role,
            },
            devicePublicId,
            appVersion: "0.1.0",
            observerVersion: "0.1.0",
          },
        );
        await deps.persist({
          server_enabled: true,
          server_device_id: result.device_id,
          server_token_expires_at: result.device_token_expires_at,
        });
        set({
          phase: "enrolled",
          deviceId: result.device_id,
          tokenExpiresAt: result.device_token_expires_at,
        });
      } catch (e) {
        set({ phase: "not_enrolled", error: e instanceof Error ? e.message : String(e) });
      }
    },

    syncNow: async () => {
      if (!deps.available()) return;
      set({ phase: "syncing", error: null });
      try {
        const outcome = await deps.invoke<{ uploaded: number; deduped: number; remaining: number }>(
          "sync_now",
        );
        const now = new Date().toISOString();
        await deps.persist({ server_last_sync_at: now });
        set({ phase: "enrolled", lastSync: outcome, lastSyncAt: now });
      } catch (e) {
        // Failures surface honestly — never a silent success.
        set({ phase: "enrolled", error: e instanceof Error ? e.message : String(e) });
      }
    },

    unenroll: async () => {
      if (!deps.available()) return;
      try {
        await deps.invoke("device_unenroll");
      } catch {
        // best-effort; the token is gone either way
      }
      await deps.persist({
        server_enabled: false,
        server_device_id: null,
        server_token_expires_at: null,
      });
      set({
        phase: "not_enrolled",
        deviceId: null,
        tokenExpiresAt: null,
        lastSync: null,
        lastSyncAt: null,
        error: null,
      });
    },
  }));
}

export const useEnrollment = createEnrollmentStore(defaultEnrollmentDeps);
