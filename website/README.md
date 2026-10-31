# Website

The landing page for `@schemavaults/sandbox-management-sdk`: a static [Next.js](https://nextjs.org) 16 export built with React 19 and [`@schemavaults/ui`](https://github.com/schemavaults/ui), deployed to GitHub Pages.

```bash
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
- **The sandbox scene** in the hero (`src/components/sandbox-scene/`) is a [Three.js](https://threejs.org) diorama. `sandbox-scene.tsx` loads `engine.ts` with a dynamic `import()` after hydration, so Three.js stays out of the page's initial JavaScript. It follows the `dark` class on `<html>` (day with a sun, clouds and a seagull; night with a moon, stars, fireflies and glowing water), pauses when off screen or when the pause button is pressed, and shows a still frame when the visitor prefers reduced motion. Clicking the sand spawns a crate that acts out the SDK lifecycle (`create()`, `stop()`, `resume()`, `destroy()`).
- **Syntax highlighting** runs at build time with [sugar-high](https://github.com/huozhi/sugar-high); its token colors are the `--sh-*` variables in `src/app/globals.css`.

## Deployment

`.github/workflows/pages.yml` builds the site on pull requests that touch it and deploys it on every push to `main`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** once.

The site is served from the root of a custom domain (set under **Pages → Custom domain**), so the workflow builds it without a base path. Without a custom domain, GitHub Pages serves the site from `/<repository>/`, and the build needs `PAGES_BASE_PATH=/<repository>` or every script, stylesheet and font returns 404. Leave it unset for local development and `bun run preview`.
