# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim
# git + build basics for the worktree pipeline and for Claude to build/test repos.
# The container itself is the isolation boundary, so we run as root inside it: the
# agent's Bash tool can install packages, run builds, and use a fully writable HOME
# without the sandbox/permission problems a locked-down host service would hit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI, available to the agent's Bash tool inside worktrees.
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

RUN mkdir -p /data /workspaces

# Runs as root (uid 0). HOME is writable for ~/.claude + toolchain caches.
ENV NODE_ENV=production \
    HOME=/root \
    PORT=8080 \
    DATA_DIR=/data \
    WORKSPACES_DIR=/workspaces

VOLUME ["/data", "/workspaces"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
