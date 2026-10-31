/**
 * The @schemavaults/ui components this site uses, imported from their own
 * modules. The package root is a single "use client" barrel that re-exports
 * the whole library, and importing from it ships every component to the
 * browser; per-component imports keep the bundle to what the page renders.
 */
export { Badge } from "@schemavaults/ui/components/ui/badge/index.js";
export { Button } from "@schemavaults/ui/components/ui/button/index.js";
export { Callout } from "@schemavaults/ui/components/ui/callout/index.js";
export {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@schemavaults/ui/components/ui/card/index.js";
export { CodeBlock, type CodeBlockProps } from "@schemavaults/ui/components/ui/code-block/index.js";
export { Separator } from "@schemavaults/ui/components/ui/separator/index.js";
export { Skeleton } from "@schemavaults/ui/components/ui/skeleton/index.js";
export { Snippet } from "@schemavaults/ui/components/ui/snippet/index.js";
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@schemavaults/ui/components/ui/table/index.js";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@schemavaults/ui/components/ui/tabs/index.js";
export { ThemeSelector } from "@schemavaults/ui/components/ui/theme-selector/index.js";
export { Wordmark } from "@schemavaults/ui/components/ui/wordmark/index.js";
export { BrightnessThemeProvider } from "@schemavaults/ui/providers/brightness-theme/index.js";
