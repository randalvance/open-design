#!/usr/bin/env bash
set -euo pipefail

# Root node_modules is a named volume, which Docker creates root-owned. It keeps
# Linux native builds (better-sqlite3, esbuild, ...) out of the host checkout;
# per-package node_modules only hold relative symlinks into it. The pnpm store
# sits inside the same volume so installs hardlink instead of copying.
sudo chown node:node node_modules

# Corepack selects the pnpm pinned in package.json#packageManager.
pnpm install --frozen-lockfile
pnpm -C e2e exec playwright install chromium

cat <<'EOF'

Open Design devcontainer ready. The desktop (Electron) shell needs a GUI, so
start daemon + web only; the web port is published at http://localhost:17573:

  pnpm tools-dev start web --daemon-port 17456 --web-port 17573

EOF
