/**
 * Joins class names. `cn` from @schemavaults/ui lives behind the package's
 * "use client" entry, so Server Components cannot call it; this does not
 * merge conflicting Tailwind classes, so avoid passing overrides.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
