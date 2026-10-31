import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { decodeBase64, encodeBase64 } from "../../src/internal/base64.js";
import * as posixPath from "../../src/internal/posix-path.js";

const SRC = nodePath.join(import.meta.dir, "..", "..", "src");

/** Entry points that must load in a browser: no Node.js built-ins, no Node globals. */
const BROWSER_ENTRY_POINTS = ["index.ts", "web-storage/index.ts", "testing/index.ts"];

/** Module specifiers of the static imports and re-exports, and dynamic imports, in `source`. */
function importsOf(source: string): string[] {
  const pattern = /^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** Every source file reachable from `entry` through relative imports. */
function moduleGraph(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith(".")) visit(nodePath.resolve(nodePath.dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  };
  visit(nodePath.join(SRC, entry));
  return files;
}

describe("browser safety", () => {
  for (const entry of BROWSER_ENTRY_POINTS) {
    it(`${entry} imports only browser-safe modules`, () => {
      for (const [file, source] of moduleGraph(entry)) {
        const relative = nodePath.relative(SRC, file);
        const bare = importsOf(source).filter((specifier) => !specifier.startsWith("."));
        expect({ file: relative, imports: bare }).toEqual({ file: relative, imports: [] });
        const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        const nodeGlobals = code.match(/\bBuffer\b|\bprocess\.(?:env|argv|cwd|versions|platform|exit|nextTick|stdout|stderr)\b|\b__dirname\b|\brequire\(/g) ?? [];
        expect({ file: relative, nodeGlobals }).toEqual({ file: relative, nodeGlobals: [] });
      }
    });
  }

  it("posix path helpers match node:path", () => {
    const paths = ["", ".", "/", "//", "a", "a/", "/a/b/", "a/./b", "a/../b", "../a", "/../a", "a/b/../../..", "./", "/a//b///c/.", "a/b/c/../../../../x"];
    for (const path of paths) {
      expect({ path, normalized: posixPath.normalize(path) }).toEqual({ path, normalized: nodePath.posix.normalize(path) });
      expect(posixPath.isAbsolute(path)).toBe(nodePath.posix.isAbsolute(path));
      for (const other of ["b", "../c", "/d", "", "./"]) {
        expect({ path, other, joined: posixPath.join(path, other) }).toEqual({
          path,
          other,
          joined: nodePath.posix.join(path, other),
        });
      }
    }
    expect(posixPath.join()).toBe(nodePath.posix.join());
  });

  it("base64 helpers match Buffer", () => {
    const samples = ["", "a", "ab", "abc", "user:pässwörd 🔑", "x".repeat(100_000)].map((text) => new TextEncoder().encode(text));
    for (const bytes of samples) {
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
    expect(new TextDecoder().decode(decodeBase64("aGVs\nbG8=\n"))).toBe("hello");
  });
});
