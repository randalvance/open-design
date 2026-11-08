# tools/pack

Follow the root `AGENTS.md` and `tools/AGENTS.md` first. This tool owns the npm package build and smoke command surface.

## Owns

- npm package build/smoke commands (`tools-pack npm build|smoke`): the single-package npm distribution of the `od` CLI, daemon, web UI, and bundled resources. See "npm package lane" below.
- Bundled resource tree manifest (`src/resources/index.ts`) and daemon CLI esbuild prebundle policy (`src/prebundle.ts`).

## Does not own

- Product business logic.
- Sidecar protocol definitions.

## Rules

- Keep source responsibilities in named directories (`config/`, `npm/`, `resources/`). Mirror those responsibilities in `tests/` when a test set has the same ownership.
- Tests import source modules through the test-only `@/*` alias. Tests that intentionally inspect source text use the same alias with Vitest's `?raw` suffix; do not reintroduce directory-depth-dependent `../src/` imports or file URLs.

## npm package lane

`pnpm tools-pack npm build` stages and packs the npm distribution under `.tmp/tools-pack/out/npm/` (`package/` is the staged tree, the `.tgz` beside it is what `npm publish` takes). `pnpm tools-pack npm smoke` installs the newest tarball into an empty prefix with `npm install`, boots the installed `od` headless on a free port, and checks `/api/health`, the web UI at `/`, and that daemon data lands in `OD_DATA_DIR` rather than inside the package. `.github/workflows/npm-publish.yml` runs both and then `npm publish`; it is dispatch-only and dry-runs by default.

Layout and the invariants it rests on (`src/npm/`):

- The package is its own daemon resource root. The bin shim sets `OD_RESOURCE_ROOT` to the package root and `OD_DATA_DIR` to a per-user directory (`$XDG_DATA_HOME/open-design/cli`, `%LOCALAPPDATA%\open-design\cli`) unless the environment already sets them. Resource trees are copied with `copyBundledResourceTrees`, the DSH companion tarball with `packBundledDshRuntime`, and the web static export (`apps/web/out`, sourcemaps stripped) as `web/`, which the daemon reads through `resolveDaemonWebStaticDir`.
- The daemon ships as one esbuild bundle at `lib/daemon/daemon-cli.mjs`, produced with the `daemonCli` prebundle policy in `src/prebundle.ts` (externals, banner, target, and forbidden-input assertion). `lib/daemon` is two directories below the package root on purpose: the daemon's `resolveProjectRoot` then resolves the package root, so every project-root fallback also points inside the package.
- Runtime dependencies are exactly the third-party externals of that policy, each pinned to the version `apps/daemon/package.json` declares (`createNpmPackageManifest` fails closed on a missing pin). `fsevents` is optional. Native modules (`better-sqlite3`, `node-pty`) install per platform through npm as usual, which is why the tarball itself stays platform-neutral.
- `@open-design/sidecar` and `@open-design/platform` are the bundle's internal externals; they ship inside `node_modules/` as `bundleDependencies` with `workspace:*` rewritten to the sibling's exact version (`rewriteBundledInternalManifest`), so npm resolves them against the bundled copies.
- The package name defaults to the root `package.json` name; `--package-name` overrides it (scoped names are accepted and published with `access: public`). `--app-version` overrides the version, which otherwise follows the root `package.json`.
- `--skip-build` reuses whatever `apps/daemon/dist` and `apps/web/out` already hold.
