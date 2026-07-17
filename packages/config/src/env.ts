import { z } from "zod";

/**
 * Fail-fast environment validation shared by API, worker, and web server.
 * Every service calls `loadServerEnv(process.env)` at startup and must crash
 * on invalid configuration rather than run misconfigured.
 */

const nonEmpty = z.string().min(1);
/** Secrets must be long random values; development defaults are rejected in production. */
const secret = z.string().min(32);

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    AUTH_MODE: z.enum(["dev", "workos"]),
    MODEL_PROVIDER: z.enum(["demo", "anthropic"]),
    CONNECTOR_MODE: z.enum(["demo", "real"]),
    DATABASE_URL: nonEmpty.url(),
    REDIS_URL: nonEmpty.url(),
    TEMPORAL_ADDRESS: nonEmpty,
    TEMPORAL_NAMESPACE: nonEmpty,
    API_BASE_URL: nonEmpty.url(),
    WEB_BASE_URL: nonEmpty.url(),
    DEVICE_TOKEN_SIGNING_SECRET: secret,
    OAUTH_STATE_SIGNING_SECRET: secret,
    CONNECTOR_ENCRYPTION_MASTER_KEY: secret,
    // Optional real integrations. Empty string means "not configured".
    WORKOS_API_KEY: z.string().optional(),
    WORKOS_CLIENT_ID: z.string().optional(),
    WORKOS_COOKIE_PASSWORD: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_CLASSIFIER_MODEL: z.string().optional(),
    ANTHROPIC_COMPILER_MODEL: z.string().optional(),
    SALESFORCE_CLIENT_ID: z.string().optional(),
    SALESFORCE_CLIENT_SECRET: z.string().optional(),
    SALESFORCE_REDIRECT_URI: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (env.AUTH_MODE === "dev") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_MODE"],
          message: "AUTH_MODE=dev is forbidden when NODE_ENV=production.",
        });
      }
      if (env.AUTH_MODE === "workos" && (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WORKOS_API_KEY"],
          message: "WORKOS_API_KEY and WORKOS_CLIENT_ID are required when AUTH_MODE=workos.",
        });
      }
      if (env.MODEL_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ANTHROPIC_API_KEY"],
          message: "ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic.",
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
    this.name = "EnvValidationError";
  }
}

export function loadServerEnv(source: Record<string, string | undefined>): ServerEnv {
  // Treat empty strings from .env templates as absent.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = serverEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues);
  }
  return parsed.data;
}
