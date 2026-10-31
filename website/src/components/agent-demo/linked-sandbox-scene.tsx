"use client";

import type { ReactElement } from "react";
import { LazySandboxScene } from "@/components/sandbox-scene/lazy-sandbox-scene";
import { agentDemoLink } from "./agent-demo-link";

/** The hero's sandbox scene, with the crates you create linked to agent sessions. */
export function LinkedSandboxScene(): ReactElement {
  return <LazySandboxScene link={agentDemoLink} />;
}
