/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Internal packages export TypeScript source that imports with .js
  // specifiers; transpile them and let webpack resolve .js → .ts.
  transpilePackages: [
    "@maman/config",
    "@maman/contracts",
    "@maman/policy-engine",
    "@maman/capability-catalog",
    "@maman/roi-engine",
  ],
  env: {
    MAMAN_API_BASE_URL: process.env.API_BASE_URL ?? "http://localhost:4000",
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
