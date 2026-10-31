"use client";

import { CodeBlock, type CodeBlockProps } from "@/lib/ui";
import type { ReactElement } from "react";

export interface HighlightedCodeBlockProps extends Omit<CodeBlockProps, "highlight" | "ref"> {
  /** `value`, already highlighted to HTML at build time. */
  html: string;
}

/**
 * `CodeBlock` takes its highlighter as a function, which cannot cross the
 * server/client boundary, so the server highlights the code and this wrapper
 * hands the finished markup to `CodeBlock`. The copy button still copies the
 * plain `value`.
 */
export function HighlightedCodeBlock({ html, ...props }: HighlightedCodeBlockProps): ReactElement {
  return <CodeBlock {...props} highlight={() => <span dangerouslySetInnerHTML={{ __html: html }} />} />;
}
