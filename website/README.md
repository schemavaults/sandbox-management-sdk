# Website

The landing page for `@schemavaults/sandbox-management-sdk`: a static [Next.js](https://nextjs.org) 16 export built with React 19 and [`@schemavaults/ui`](https://github.com/schemavaults/ui), deployed to GitHub Pages.

The hero's agent demo imports the SDK's build from `../dist` (`tsconfig.json` maps the package name there), so build the SDK in the repository root first, and again after changing it:

```bash
(cd .. && bun install && bun run build)
bun install
bun run dev        # http://localhost:3000
bun run typecheck
bun run build      # static export in ./out
bun run preview    # serve ./out locally
```

## How it fits together

- **Styling.** Tailwind CSS 3 with the `@schemavaults/theme` config factory (`tailwind.config.ts`); `@schemavaults/theme/globals.css` supplies the light and dark tokens. Fonts are Geist and Geist Mono via `next/font`, self-hosted at build time.
- **Components.** `src/lib/ui.ts` imports each `@schemavaults/ui` component from its own module. The package root is one `"use client"` barrel, and importing from it ships the whole library to the browser. Add new components there.
- **Content.** Code samples are in `src/content/snippets.ts` and mirror the repository README. The version, description and license come from the SDK's `../package.json` at build time.
- **The sandbox scene** in the hero (`src/components/sandbox-scene/`) is a [Three.js](https://threejs.org) diorama. The hero renders `LazySandboxScene` (`lazy-sandbox-scene.tsx`), which loads `sandbox-scene.tsx` and Three.js with `next/dynamic` (`ssr: false`) as one chunk after hydration, so they stay out of the page's initial JavaScript. Until then a skeleton of the sandbox and its controls (`sandbox-scene-skeleton.tsx`) holds the scene's place in the same frame, so nothing shifts; the static HTML ships with it, and it stays up until the first frame is drawn, then crossfades into the scene. It follows the `dark` class on `<html>` (day with a sun, clouds and a seagull; night with a moon, stars, fireflies and glowing water), pauses when off screen or when the pause button is pressed, and shows a still frame when the visitor prefers reduced motion. Clicking the sand spawns a crate that acts out the SDK lifecycle (`create()`, `stop()`, `resume()`, `destroy()`).
- **The agent demo** (`src/components/agent-demo/`) makes the crates real. Clicking the sand still spawns a crate, and now also starts an agent session: a real `SandboxManager` creates a sandbox for it on `BrowserSandboxProvider`, an ephemeral provider that lives in the tab (an in-memory filesystem and a toy shell, `toy-shell.ts`), and keeps its record in sessionStorage through `WebStorageSandboxStore`. The agent (`agent.ts`) is a tiny loop around `dummy-llm.ts`, a virtually useless model that maps a few keywords to shell commands and runs them with `SandboxManager.exec`. Store writes drive the crates (`crate-link.ts`), so clicking a crate calls `stop()` or `resume()`, a message to a stopped sandbox auto-resumes it and wakes its crate, and evicting a crate destroys its sandbox. A floating button opens the sessions in `@schemavaults/ui`'s `AgentSessions` dialog. All of it is lazy: the page itself only ships `agent-demo-link.ts` and two small loaders. The button's chunk loads when the browser is idle, the demo logic loads on the first click on the sand or when the visitor reaches for the button, and the dialog's contents load on hover, focus or open. Sandboxes end with the page, so the demo clears the records an earlier visit left in the tab when it starts.
- **Syntax highlighting** runs at build time with [sugar-high](https://github.com/huozhi/sugar-high); its token colors are the `--sh-*` variables in `src/app/globals.css`.

## Deployment

`.github/workflows/pages.yml` builds the site on pull requests that touch it and deploys it on every push to `main`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** once.

The site is served from the root of a custom domain (set under **Pages → Custom domain**), so the workflow builds it without a base path. Without a custom domain, GitHub Pages serves the site from `/<repository>/`, and the build needs `PAGES_BASE_PATH=/<repository>` or every script, stylesheet and font returns 404. Leave it unset for local development and `bun run preview`.
