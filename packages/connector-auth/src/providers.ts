/**
 * OAuth provider registry (Connector Broker). Minimum scopes only.
 * NOTE deliberate absences: no gmail.send scope, no destructive scopes.
 */

export type ProviderId =
  "salesforce" | "google_sheets" | "gmail" | "google_calendar" | "slack" | "hubspot";

export type ProviderConfig = {
  id: ProviderId;
  display_name: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  supports_pkce: boolean;
  /** Minimum scopes for v1 capabilities. */
  scopes: string[];
  /** Whether an admin-approved enterprise install is supported. */
  supports_enterprise_install: boolean;
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  salesforce: {
    id: "salesforce",
    display_name: "Salesforce",
    authorization_endpoint: "https://login.salesforce.com/services/oauth2/authorize",
    token_endpoint: "https://login.salesforce.com/services/oauth2/token",
    revocation_endpoint: "https://login.salesforce.com/services/oauth2/revoke",
    supports_pkce: true,
    scopes: ["api", "refresh_token"],
    supports_enterprise_install: true,
  },
  google_sheets: {
    id: "google_sheets",
    display_name: "Google Sheets",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    revocation_endpoint: "https://oauth2.googleapis.com/revoke",
    supports_pkce: true,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    supports_enterprise_install: true,
  },
  gmail: {
    id: "gmail",
    display_name: "Gmail (metadata + drafts only)",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    revocation_endpoint: "https://oauth2.googleapis.com/revoke",
    supports_pkce: true,
    // metadata + compose (drafts). NEVER gmail.send.
    scopes: [
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    supports_enterprise_install: true,
  },
  google_calendar: {
    id: "google_calendar",
    display_name: "Google Calendar",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    revocation_endpoint: "https://oauth2.googleapis.com/revoke",
    supports_pkce: true,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    supports_enterprise_install: true,
  },
  slack: {
    id: "slack",
    display_name: "Slack",
    authorization_endpoint: "https://slack.com/oauth/v2/authorize",
    token_endpoint: "https://slack.com/api/oauth.v2.access",
    supports_pkce: false, // Slack app installs use client secret server-side
    scopes: ["channels:read", "chat:write.customize"],
    supports_enterprise_install: true,
  },
  hubspot: {
    id: "hubspot",
    display_name: "HubSpot",
    authorization_endpoint: "https://app.hubspot.com/oauth/authorize",
    token_endpoint: "https://api.hubapi.com/oauth/v1/token",
    supports_pkce: false,
    scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    supports_enterprise_install: true,
  },
};

export function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS[id as ProviderId];
}
