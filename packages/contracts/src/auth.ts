import { z } from "zod";
import { utcTimestamp, uuid } from "./common.js";

export const organizationRole = z.enum([
  "member",
  "manager",
  "org_admin",
  "security_admin",
  "billing_admin",
]);
export type OrganizationRole = z.infer<typeof organizationRole>;

/** Authenticated principal attached to every API request after auth. */
export const principalSchema = z
  .object({
    user_id: uuid,
    organization_id: uuid,
    role: organizationRole,
    /** Set when the request authenticated with a device token instead of a user token. */
    device_id: uuid.optional(),
    auth_mode: z.enum(["dev", "workos", "device"]),
  })
  .strict();
export type Principal = z.infer<typeof principalSchema>;

export const deviceRegisterRequestSchema = z
  .object({
    device_public_id: uuid,
    platform: z.literal("macos"),
    app_version: z.string().min(1),
    observer_version: z.string().min(1),
    capabilities: z.array(z.enum(["macos_ax", "chrome_native_messaging", "demo_observer"])),
  })
  .strict();
export type DeviceRegisterRequest = z.infer<typeof deviceRegisterRequestSchema>;

export const deviceRegisterResponseSchema = z
  .object({
    device_id: uuid,
    device_token: z.string().min(1),
    device_token_expires_at: utcTimestamp,
    sync_policy: z
      .object({
        max_batch_size: z.number().int().positive(),
        min_sync_interval_seconds: z.number().int().positive(),
      })
      .strict(),
    server_time: utcTimestamp,
  })
  .strict();
export type DeviceRegisterResponse = z.infer<typeof deviceRegisterResponseSchema>;

export const desktopAuthExchangeRequestSchema = z
  .object({
    authorization_code: z.string().min(1),
    pkce_verifier: z.string().min(43).max(128),
    device_public_id: uuid,
  })
  .strict();
export type DesktopAuthExchangeRequest = z.infer<typeof desktopAuthExchangeRequestSchema>;

export const desktopAuthExchangeResponseSchema = z
  .object({
    access_token: z.string().min(1),
    access_token_expires_at: utcTimestamp,
    refresh_token: z.string().min(1),
    user_id: uuid,
    organization_id: uuid,
  })
  .strict();
export type DesktopAuthExchangeResponse = z.infer<typeof desktopAuthExchangeResponseSchema>;

export const desktopAuthRefreshRequestSchema = z
  .object({
    refresh_token: z.string().min(1),
    device_public_id: uuid,
  })
  .strict();
export type DesktopAuthRefreshRequest = z.infer<typeof desktopAuthRefreshRequestSchema>;

/** RFC 9457 problem details error shape used by every API error response. */
export const problemDetailsSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    request_id: z.string().optional(),
  })
  .strict();
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
