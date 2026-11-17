---
name: bump-version
description: Bump this package's version after committing changes that ship, so that merging the branch to main releases them. Use once you have committed changes on a branch to src/, images/egress-proxy/ or the package.json fields users get (dependencies, exports, files, engines), before you push the branch or open or update its pull request. Covers whether a bump is needed, choosing patch or minor, the egress proxy image tag that must match the version, and not bumping twice on one branch.
---

# Bump the version

Merging to `main` releases the version in `package.json` if it is new: `.github/workflows/publish.yml` publishes the package to npm and GitHub Packages, pushes the egress proxy image `ghcr.io/schemavaults/sandbox-egress-proxy:<version>`, and tags the commit `v<version>`. A change merged without a bump reaches no one until the next bump. A released version is never published again (image tags never change), so even a one-line fix needs a new version.

## Is a bump needed?

Yes if the branch changes what ships:

- `src/` (the package is built from it)
- `images/egress-proxy/` (the image `DOCKER_EGRESS_PROXY_IMAGE` points at)
- `package.json` fields users get: `dependencies`, `peerDependencies`, `exports`, `files`, `engines`

No if it only changes `tests/`, `.github/`, `website/`, `.claude/`, lint or editor config, or only the README.

Bump once per branch. Check whether the branch already has:

```bash
git fetch origin main
git show origin/main:package.json | grep '"version"'
grep '"version"' package.json
```

If the branch's version is already above `main`'s, leave it, unless the branch now needs a bigger bump than the one it has (a patch bump on a branch that now breaks the API becomes a minor bump from `main`'s version).

## Patch or minor?

Bump from `main`'s version. While the package is at 0.x, npm's `^0.1.1` accepts only `0.1.x`, so:

- **Minor** (`0.1.1` → `0.2.0`) for a breaking change: removed or changed exports, types, `SandboxSpec` fields or provider options; a store schema change that needs a migration; a higher minimum Node or peer dependency version; proxy behavior users rely on.
- **Patch** (`0.1.1` → `0.1.2`) for everything else: fixes, additive features, internal rewrites that keep behavior, dependency updates within range.

From 1.0 on: major for breaking changes, minor for features, patch for fixes.

## Make the bump

Change the version in both places; `tests/unit/docker-provider.test.ts` checks they match:

1. `version` in `package.json`
2. the tag in `DOCKER_EGRESS_PROXY_IMAGE` in `src/docker/egress.ts`

Nothing else holds it: `bun.lock` does not record the root version, and the website reads `package.json`. Then commit the bump on its own, after the changes it releases:

```bash
bun run test:unit
git add package.json src/docker/egress.ts
git commit -m "Bump version to <version>"
```

Push it with the branch, and say in the pull request which version it releases and why that bump. Do not bump on `main` directly, and do not create the tag or GitHub release: the publish workflow does both.

If `main` moved to the same or a higher version before the branch merges (merging `main` conflicts on `version`), take `main`'s version and bump again from it.
