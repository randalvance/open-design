# tools/pack

npm packaging control plane for Open Design.

`tools-pack` provides the npm distribution build and smoke verification commands:

- `pnpm tools-pack npm build`
- `pnpm tools-pack npm build --package-name @scope/open-design --skip-build`
- `pnpm tools-pack npm smoke`

Build artifacts are written under `.tmp/tools-pack/out/npm/`. See `tools/pack/AGENTS.md` for layout and invariants.
