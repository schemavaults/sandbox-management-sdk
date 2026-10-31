import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SdkPackageInfo {
  name: string;
  version: string;
  description: string;
  license: string;
  nodeEngine: string | undefined;
}

let cached: SdkPackageInfo | undefined;

/**
 * Reads the SDK's package.json (one directory above this app) at build time,
 * so the version and description on the page always match the published
 * package. Only call this from Server Components.
 */
export function getSdkPackage(): SdkPackageInfo {
  if (!cached) {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "..", "package.json"), "utf8")) as {
      name: string;
      version: string;
      description: string;
      license: string;
      engines?: { node?: string };
    };
    cached = {
      name: raw.name,
      version: raw.version,
      description: raw.description,
      license: raw.license,
      nodeEngine: raw.engines?.node,
    };
  }
  return cached;
}
