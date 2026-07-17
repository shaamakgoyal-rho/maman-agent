/**
 * Single source of truth for product identity.
 * The product can be renamed by editing this file alone — never hardcode
 * these strings elsewhere in the repository.
 */
export const product = {
  /** Product display name. */
  name: "Maman",
  /** Machine-safe product slug used in identifiers, bundle IDs, and paths. */
  slug: "maman",
  /** Repository name. */
  repository: "maman-agent",
  tagline: "A desktop pet that notices repetitive work and builds safe helpers for you.",
  mascot: {
    /** The pet's name as shown in UI copy. */
    name: "Maman",
    /** Calm, factual voice. Never surveillance-toned. */
    voice: "calm",
  },
  company: {
    supportEmail: "support@maman.example",
    securityEmail: "security@maman.example",
    privacyUrl: "https://maman.example/privacy",
    docsUrl: "https://maman.example/docs",
  },
  macos: {
    bundleIdentifier: "com.maman.desktop",
    observerBinaryName: "maman-observer",
    browserHostBinaryName: "maman-browser-host",
    nativeMessagingHostName: "com.maman.browser_host",
    keychainService: "com.maman.desktop.keys",
  },
  chrome: {
    /** Production extension ID — set after first packing; dev ID documented in docs. */
    productionExtensionId: "",
    developmentExtensionIdDocPath: "docs/architecture/extension-pairing.md",
  },
} as const;

export type Product = typeof product;
