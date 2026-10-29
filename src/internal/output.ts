import { Writable } from "node:stream";

/** A Writable that decodes UTF-8 output, forwards each chunk and keeps the full text. */
export function outputCollector(onChunk?: (chunk: string) => void): {
  writable: Writable;
  finish: () => string;
} {
  const decoder = new TextDecoder();
  let text = "";
  const push = (chunk: string) => {
    if (!chunk) return;
    text += chunk;
    onChunk?.(chunk);
  };
  const writable = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
      callback();
    },
  });
  return {
    writable,
    finish: () => {
      push(decoder.decode());
      return text;
    },
  };
}
