# Release Guide

This document covers how to build, smoke-test, and publish a new release of `@randalvance/open-design` to npm.

## Overview

Releases are automated by [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml). When a GitHub Release is published (or when the workflow is triggered manually via `workflow_dispatch`), the pipeline:

1. **Builds the npm tarball** (`pnpm --silent tools-pack npm build --json`): bundles the `od` CLI, local daemon, static web UI export, and bundled skills, design systems, templates, and official plugins into a single platform-neutral `.tgz`.
2. **Smoke-tests the tarball** (`pnpm --silent tools-pack npm smoke --tarball <path> --json`): installs the tarball into an empty prefix via `npm install`, verifies `od --help`, boots the daemon headless on a free port, checks `/api/health` and the web UI at `/`, and verifies daemon data directory isolation (see `AGENTS.md` → **Daemon data directory contract**).
3. **Uploads the artifact**: attaches the built `.tgz` as the `npm-package` workflow artifact.
4. **Publishes to npm**: runs `npm publish <tarball> --access public --provenance --tag <dist_tag>` using keyless OIDC Trusted Publishing and Sigstore provenance signing.

---

## One-Time Setup (npm Trusted Publishing)

Keyless publishing from GitHub Actions requires a Trusted Publisher configured on npmjs.com:

1. Open **`https://www.npmjs.com/package/@randalvance/open-design/access`**.
2. Under **Trusted Publisher**, configure **GitHub Actions**:
   - **Organization or user**: `randalvance`
   - **Repository**: `open-design`
   - **Workflow filename**: `npm-publish.yml`
   - **Environment name**: *(leave empty)*
   - **Permissions**: Enable **Allow `npm publish`** (direct publishing).
3. Keep the matching `repository` field in the root [`package.json`](../package.json) (`git+https://github.com/randalvance/open-design.git`), which `tools-pack npm build` copies into the published manifest for provenance verification.

> **Fallback (`NPM_TOKEN`)**: If you ever need to publish with a token instead of OIDC, add an `NPM_TOKEN` repository secret under GitHub **Settings → Secrets and variables → Actions**. When `secrets.NPM_TOKEN` is empty, `npm-publish.yml` uses keyless OIDC automatically.

---

## Standard Release Steps

### 1. Verify `main` is ready
Make sure all target PRs are merged into `main` and the [`CI` workflow](../.github/workflows/ci.yml) is green on `main`.

*(Optional)* Bump the `"version"` field in the root [`package.json`](../package.json) via PR so the repository default version matches the upcoming release tag. Even if you skip this, `npm-publish.yml` automatically strips the leading `v` from the release tag (`vX.Y.Z` → `X.Y.Z`) and passes `--app-version` to `tools-pack npm build`.

### 2. Create and publish a GitHub Release

#### Option A — Using GitHub CLI (`gh`)
```bash
# Stable release (publishes under --tag latest)
gh release create v0.25.3 \
  --repo randalvance/open-design \
  --target main \
  --title "v0.25.3" \
  --generate-notes

# Prerelease (publishes under --tag next)
gh release create v0.26.0-rc.1 \
  --repo randalvance/open-design \
  --target main \
  --title "v0.26.0-rc.1" \
  --prerelease \
  --generate-notes
```

#### Option B — Using the GitHub Web UI
1. Go to **`https://github.com/randalvance/open-design/releases/new`**.
2. Click **Choose a tag**, enter `vX.Y.Z` (e.g., `v0.25.3`), and select **Create new tag on publish** targeting `main`.
3. Click **Generate release notes** (or write custom notes).
4. Leave **Set as a pre-release** unchecked for stable (`latest` dist-tag) or check it for prereleases (`next` dist-tag).
5. Click **Publish release**.

### 3. Monitor the `npm-publish` workflow
```bash
# Find the triggered run ID
gh run list --repo randalvance/open-design --workflow npm-publish.yml --limit 1

# Watch the run until completion
gh run watch <run-id> --repo randalvance/open-design --exit-status
```

### 4. Verify the published package on npm
```bash
npm view @randalvance/open-design version dist-tags --registry https://registry.npmjs.org
```

> **Note**: Because the package tarball is ~147 MB, npm prints `Your package is being processed and may take a few minutes to become available` after `npm publish` succeeds while the registry finishes background scanning and indexing.

---

## Manual / Dry-Run Dispatch

You can trigger `npm-publish.yml` manually without creating a GitHub Release:

```bash
# Dry-run build + smoke + npm publish --dry-run (default: dry_run=true)
gh workflow run npm-publish.yml --repo randalvance/open-design \
  -f package_name="@randalvance/open-design" \
  -f app_version="0.25.3" \
  -f dist_tag="latest" \
  -f dry_run=true

# Real manual publish (dry_run=false)
gh workflow run npm-publish.yml --repo randalvance/open-design \
  -f package_name="@randalvance/open-design" \
  -f app_version="0.25.3" \
  -f dist_tag="latest" \
  -f dry_run=false
```

---

## Local Pre-Release Validation

To build and smoke-test the npm package locally before cutting a release:

```bash
pnpm tools-pack npm build --package-name @randalvance/open-design --app-version 0.25.3
pnpm tools-pack npm smoke --package-name @randalvance/open-design
```

The staged package and `.tgz` tarball are written under `.tmp/tools-pack/out/npm/`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403 Forbidden - PUT ... - OIDC permission denied for this action` | The Trusted Publisher on npmjs.com only has `Allow npm stage` enabled, or the workflow filename/repo does not match. | In `https://www.npmjs.com/package/@randalvance/open-design/access`, edit the Trusted Publisher, enable **Allow `npm publish`**, and run `gh run rerun <run-id> --repo randalvance/open-design --failed`. |
| `You cannot publish over the previously published versions: X.Y.Z` | Version `X.Y.Z` was already published to npm (npm versions are immutable). | Create a new release with the next version tag (e.g., `vX.Y.(Z+1)`). |
| Transient failure during build, smoke, or upload | Runner network blip before `Publish` ran. | Re-run the failed job in place: `gh run rerun <run-id> --repo randalvance/open-design --failed`. |
