/**
 * The POSIX path helpers the core needs, without `node:path`, so the core
 * also runs in browsers. Same results as `posix.isAbsolute`,
 * `posix.normalize` and `posix.join` from `node:path`.
 */

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function normalize(path: string): string {
  if (path === "") return ".";
  const absolute = isAbsolute(path);
  const trailingSlash = path.endsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
    } else if (segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
    } else if (!absolute) {
      segments.push("..");
    }
  }
  let result = segments.join("/");
  if (result === "") return absolute ? "/" : trailingSlash ? "./" : ".";
  if (trailingSlash) result += "/";
  return absolute ? `/${result}` : result;
}

export function join(...paths: string[]): string {
  const joined = paths.filter((path) => path !== "").join("/");
  return joined === "" ? "." : normalize(joined);
}
