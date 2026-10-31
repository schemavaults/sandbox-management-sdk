import type { NextConfig } from "next";

// GitHub Pages serves a project site from /<repository>/. The Pages workflow
// passes that prefix (from actions/configure-pages) as PAGES_BASE_PATH; it is
// empty for local development and for a custom domain.
const basePath = (process.env.PAGES_BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // The SDK's own bun.lock sits one level up; pin the root to this app.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
