import { highlight as sugarHighlight } from "sugar-high";

export type CodeLanguage = "ts" | "bash";

/**
 * Highlights code to an HTML string at build time. Token colors come from the
 * `--sh-*` custom properties in globals.css, so they follow the color theme.
 */
export function highlightCode(code: string, language: CodeLanguage): string {
  return sugarHighlight(code, { lang: language === "ts" ? "typescript" : "shell" });
}
