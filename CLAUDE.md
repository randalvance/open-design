@AGENTS.md

# Run everything in the devcontainer

Always run repository commands (`pnpm install`, `pnpm tools-dev`, `pnpm guard`, `pnpm typecheck`, package-scoped tests and builds, e2e) inside the devcontainer defined in `.devcontainer/`, not on the host. The host may not have the required Node 24 / pnpm toolchain, and the container keeps its own Linux `node_modules` on a named volume.

- From the host, start or reuse the container with `devcontainer up --workspace-folder .`, then run each command through `devcontainer exec --workspace-folder . bash -lc '<command>'`.
- The desktop (Electron) shell cannot run in the container; use `pnpm tools-dev start web --daemon-port 17456 --web-port 17573`. The web port is published to the host at `http://localhost:17573` (the container sets `OD_HOST=0.0.0.0` for the web listener); the daemon stays on container loopback behind the web proxy.
- Git operations and editing files may happen on the host; the workspace is bind-mounted.
