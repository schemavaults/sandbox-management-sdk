import type { ReactElement } from "react";
import { LazyAgentSessionsFab } from "@/components/agent-demo/lazy-agent-sessions-fab";
import { Features } from "@/components/sections/features";
import { GetStarted } from "@/components/sections/get-started";
import { Hero } from "@/components/sections/hero";
import { Install } from "@/components/sections/install";
import { Lifecycle } from "@/components/sections/lifecycle";
import { Processes } from "@/components/sections/processes";
import { Providers } from "@/components/sections/providers";
import { QuickStart } from "@/components/sections/quick-start";
import { Spec } from "@/components/sections/spec";
import { Stores } from "@/components/sections/stores";
import { Testing } from "@/components/sections/testing";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getSdkPackage } from "@/lib/sdk-package";

export default function HomePage(): ReactElement {
  const sdk = getSdkPackage();
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero sdk={sdk} />
        <Features />
        <Install />
        <QuickStart />
        <Lifecycle />
        <Spec />
        <Processes />
        <Providers />
        <Stores />
        <Testing />
        <GetStarted />
      </main>
      <SiteFooter sdk={sdk} />
      <LazyAgentSessionsFab />
    </>
  );
}
