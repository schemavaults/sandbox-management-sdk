import { dirname } from "node:path";
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
  // The hero's agent demo imports the SDK's build in ../dist (see the
  // tsconfig paths; run `bun run build` in the repository root first), so
  // the root is the repository, which also holds the SDK's own bun.lock.
  turbopack: { root: dirname(import.meta.dirname) },
};

export default nextConfig;
