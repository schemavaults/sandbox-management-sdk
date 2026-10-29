import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTar, extractFirstFile } from "../../src/docker/tar.js";

describe("tar", () => {
  it("round-trips a file", () => {
    const content = new TextEncoder().encode("hello tar");
    const tar = createTar([{ path: "/a/b.txt", content, mode: 0o644 }]);
    expect(tar.length % 512).toBe(0);
    expect(extractFirstFile(tar)).toEqual({ path: "a/b.txt", content });
  });

  it("uses PAX headers for long paths", () => {
    const path = `${"dir/".repeat(40)}file.txt`;
    const content = new Uint8Array([0, 1, 2, 255]);
    expect(extractFirstFile(createTar([{ path, content, mode: 0o600 }]))).toEqual({ path, content });
  });

  it("produces archives the system tar accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-sdk-tar-"));
    try {
      const longPath = `${"nested/".repeat(20)}deep.txt`;
      const tar = createTar([
        { path: "x/run.sh", content: new TextEncoder().encode("#!/bin/sh\n"), mode: 0o755 },
        { path: longPath, content: new TextEncoder().encode("deep"), mode: 0o644 },
      ]);
      await Bun.write(join(dir, "a.tar"), tar);
      const result = Bun.spawnSync(["tar", "-xf", "a.tar"], { cwd: dir });
      expect(result.stderr.toString()).toBe("");
      expect(await readFile(join(dir, "x/run.sh"), "utf8")).toBe("#!/bin/sh\n");
      expect((await stat(join(dir, "x/run.sh"))).mode & 0o777).toBe(0o755);
      expect(await readFile(join(dir, longPath), "utf8")).toBe("deep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads archives made by the system tar, and rejects directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-sdk-tar-"));
    try {
      await Bun.write(join(dir, "f.txt"), "from system tar");
      Bun.spawnSync(["tar", "-cf", "f.tar", "f.txt"], { cwd: dir });
      const file = extractFirstFile(new Uint8Array(await readFile(join(dir, "f.tar"))));
      expect(new TextDecoder().decode(file!.content)).toBe("from system tar");

      Bun.spawnSync(["tar", "-cf", "d.tar", "."], { cwd: dir });
      const dirTar = new Uint8Array(await readFile(join(dir, "d.tar")));
      expect(() => extractFirstFile(dirTar)).toThrow("is a directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
