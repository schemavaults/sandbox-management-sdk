"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ReactElement } from "react";

const AgentSessionsFab = dynamic(
  () =>
    import("./agent-sessions-fab").then(
      (mod) => mod.AgentSessionsFab,
      // Without its chunk there is simply no button.
      () => () => null,
    ),
  { ssr: false },
);

/**
 * The agent sessions button, fetched once the browser is idle after the
 * page loads: neither the button, the dialog, nor the demo behind it is in
 * the page's initial JavaScript.
 */
export function LazyAgentSessionsFab(): ReactElement | null {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => setShow(true), { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => setShow(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);
  return show ? <AgentSessionsFab /> : null;
}
