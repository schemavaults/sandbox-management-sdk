import { Button } from "@/lib/ui";
import Link from "next/link";
import type { ReactElement } from "react";
import { LogoMark } from "@/components/logo-mark";

export default function NotFound(): ReactElement {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-4">
      <div className="text-center">
        <LogoMark size="lg" className="mx-auto" />
        <p className="mt-6 font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">This page could not be found</h1>
        <Button asChild className="mt-8">
          <Link href="/">Back to the SDK overview</Link>
        </Button>
      </div>
    </main>
  );
}
