import type { ReactElement } from "react";
import { highlightCode, type CodeLanguage } from "@/lib/highlight";
import { HighlightedCodeBlock } from "./highlighted-code-block";

export interface CodeProps {
  code: string;
  language?: CodeLanguage;
  title?: string;
  className?: string;
}

export function Code({ code, language = "ts", title, className }: CodeProps): ReactElement {
  return (
    <HighlightedCodeBlock
      value={code}
      html={highlightCode(code, language)}
      language={language}
      title={title}
      size="sm"
      className={className}
    />
  );
}
