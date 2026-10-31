import type { NextConfig } from "next";

// The site is deployed to the root of a custom domain, so the Pages workflow
// builds it without a base path. Set PAGES_BASE_PATH (e.g. "/<repository>")
// only to serve it from a GitHub Pages project URL instead.
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
