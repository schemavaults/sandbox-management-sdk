/**
 * Minimal POSIX tar support for Docker's archive endpoints: write regular
 * files (with PAX headers for long paths) and read back the first file.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TarFileEntry {
  /** Path inside the archive, without a leading slash. */
  path: string;
  content: Uint8Array;
  mode: number;
}

export function createTar(entries: TarFileEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, "");
    if (encoder.encode(path).length > 100) {
      const pax = paxRecord("path", path);
      parts.push(header({ name: "././@PaxHeader", mode: 0o644, size: pax.length, mtime, type: "x" }), pad(pax));
    }
    parts.push(
      header({ name: truncateUtf8(path, 100), mode: entry.mode, size: entry.content.length, mtime, type: "0" }),
      pad(entry.content),
    );
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}

export interface TarExtractedFile {
  path: string;
  content: Uint8Array;
}

/**
 * The first regular file in the archive. Throws if the archive's first entry
 * is a directory; resolves `null` for an empty archive.
 */
export function extractFirstFile(tar: Uint8Array): TarExtractedFile | null {
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) return null;
    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      paxPath = parsePax(data).path ?? paxPath;
      continue;
    }
    if (type === "L") {
      paxPath = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    if (type === "5") throw new Error(`"${path}" is a directory`);
    if (type === "0" || type === "\0") return { path, content: data.slice() };
  }
  return null;
}

function header(fields: { name: string; mode: number; size: number; mtime: number; type: string }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, fields.name);
  writeOctal(block, 100, 8, fields.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, fields.size);
  writeOctal(block, 136, 12, fields.mtime);
  block.fill(0x20, 148, 156); // checksum is computed with this field as spaces
  block[156] = fields.type.charCodeAt(0);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeString(block, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function paxRecord(key: string, value: string): Uint8Array {
  // A record is "<length> <key>=<value>\n", where <length> counts its own digits.
  const bodyLength = encoder.encode(` ${key}=${value}\n`).length;
  let length = bodyLength;
  while (bodyLength + String(length).length !== length) length = bodyLength + String(length).length;
  return encoder.encode(`${length} ${key}=${value}\n`);
}

function parsePax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  for (const line of decoder.decode(data).split("\n")) {
    const match = /^\d+ ([^=]+)=(.*)$/s.exec(line);
    if (match?.[1]) records[match[1]] = match[2] ?? "";
  }
  return records;
}

function pad(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  return padded;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (encoder.encode(result).length > maxBytes) result = result.slice(1);
  return result;
}
