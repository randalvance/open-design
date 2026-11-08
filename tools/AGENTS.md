# tools/AGENTS.md

Follow the root `AGENTS.md` first. This file only records module-level boundaries for `tools/`.

## Active tools

- `tools/dev` provides `@open-design/tools-dev` and the `tools-dev` bin. It is the only currently active local development lifecycle control plane.
- `pnpm tools-dev` manages daemon -> web.
- `pnpm tools-dev run web` runs foreground daemon + web for the Playwright webServer flow.
- `tools/pack` provides `@open-design/tools-pack` and the `tools-pack` bin. It owns the npm package lane (`tools-pack npm build|smoke`).

## Retired tools

- `tools/pr` / `@open-design/tools-pr` / `pnpm tools-pr` has been retired from this repository. Maintainer PR-duty workflows now live outside the product workspace in `PerishCode/duty`; do not restore an OpenDesign-local PR-duty tool without a new explicit maintainer decision.

## Packaging scope

- Keep `tools-pack` focused on the npm package distribution (`tools-pack npm build|smoke`).
- There is no root `pnpm build` aggregate. Use package-scoped builds for source packages and `pnpm tools-pack npm ...` for the npm package lane.

## Orchestration boundary

- Tool tests live in each tool's `tests/` directory, sibling to `src/`; keep `src/` source-only and do not add new `*.test.ts` or `*.test.tsx` files under `src/`.
- Orchestration layers must consume primitives from `@open-design/sidecar-proto`, `@open-design/sidecar`, and `@open-design/platform`.
- Do not hand-build `--od-stamp-*` args, process-scan regexes, runtime tokens, process roles, or duplicate namespace/source args in `tools/dev` or `tools/pack`.
- Port flags are authoritative inputs: `--daemon-port` and `--web-port`. Internal env vars are `OD_PORT` and `OD_WEB_PORT`; do not introduce `NEXT_PORT`.

## Common tools commands

```bash
pnpm --filter @open-design/tools-dev typecheck
pnpm --filter @open-design/tools-dev build
pnpm --filter @open-design/tools-pack typecheck
pnpm --filter @open-design/tools-pack build
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev check
pnpm tools-pack npm build
pnpm tools-pack npm build --package-name @scope/open-design --skip-build
pnpm tools-pack npm smoke
```
