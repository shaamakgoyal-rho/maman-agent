export { fetchTransport, type HttpRequest, type HttpResponse, type HttpTransport } from "./http.js";
export {
  MemoryIdempotencyStore,
  throwForStatus,
  throwTransientNetwork,
  type CredentialProvider,
  type ProviderCredentials,
  type IdempotencyStore,
} from "./credentials.js";
export {
  salesforceCapabilities,
  SF_API_VERSION,
  DEFAULT_SF_FIELD_MAP,
  type SalesforceFieldMap,
  type SalesforceAdapterConfig,
} from "./salesforce.js";
export { googleSheetsCapabilities, type GoogleSheetsAdapterConfig } from "./google-sheets.js";
export {
  realAdapterRegistry,
  ConnectorNotLinkedError,
  type RealRegistryConfig,
} from "./registry.js";
