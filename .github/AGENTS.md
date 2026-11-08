# GitHub automation guide

This repository keeps GitHub Actions focused on two workflows:

- `.github/workflows/ci.yml`: PR check (`pull_request`), merge check (`push` to `main` and `merge_group`), and manual validation (`workflow_dispatch`).
- `.github/workflows/npm-publish.yml`: npm release pipeline, triggered when a GitHub Release is published (`release: types: [published]`) or via manual `workflow_dispatch`.

## Required reading

Before changing GitHub automation, read the current versions of:

- `.github/workflows/ci.yml`
- `.github/workflows/npm-publish.yml`
- `.github/config/runners.json`, `.github/config/scopes.json`, and `.github/config/convergence.json`
- `.github/scripts/runners.py`, `.github/scripts/scopes.py`, and `.github/scripts/convergence.py`
- `.github/scripts/handoff.py`
- `specs/current/ci.md` when changing scope rules, confidence tiers, or planner invariants

## Architecture

- `ci.yml` resolves runners, composes scope and convergence decisions in its Linux `plan` job, and runs workspace validation on PRs and merges to `main`.
- `npm-publish.yml` builds the single-package npm distribution (`pnpm tools-pack npm build`), smoke-tests the tarball (`pnpm tools-pack npm smoke`), uploads the tarball artifact, and publishes to npm when a GitHub release is published.

## Directory conventions

- `.github/workflows/` contains ONLY `ci.yml` and `npm-publish.yml`.
- `.github/actions/` contains reusable composite actions for workflow setup steps (`configure-ci-parallelism`, `setup-playwright`, `setup-workspace`).
- `.github/scripts/` contains workflow-owned scripts and contracts (`scopes.py`, `convergence.py`, `postinstall.py`, `runners.py`, `handoff.py`, `template.py`, `workspace.py`).
- `.github/templates/` contains non-executable `.md` and `.txt` delivery templates rendered by `.github/scripts/template.py`.
- Root `scripts/` remains for repo-level developer checks, product scripts, and guard/test logic.

## Common iteration flow

1. Update scope routing in `.github/config/scopes.json`, then run `python3 .github/scripts/scopes.py validate`.
2. Update workload input closure in `.github/config/convergence.json`, then run `python3 .github/scripts/convergence.py validate`.
3. Run the focused checks:
   - `python3 .github/scripts/postinstall.py validate`
   - `python3 .github/scripts/handoff.py self-check`
   - `pnpm --filter @open-design/e2e test tests/scripts`
4. Run repo-level checks before handing off:
   - `pnpm guard`
   - `pnpm typecheck`
