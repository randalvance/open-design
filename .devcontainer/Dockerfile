# Node 24 on Debian bookworm. The non-slim base already carries python3, make
# and g++, which better-sqlite3 needs when no prebuilt binary matches.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# OS libraries for the Playwright Chromium used by e2e/ui. The browser binary
# itself is downloaded per-user in post-create, pinned by e2e's lockfile entry.
RUN npx -y playwright@1.60.0 install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
