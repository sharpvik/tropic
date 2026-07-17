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
# git: required for the worktree pipeline. ca-certificates: HTTPS push/API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI, available to the agent's Bash tool inside worktrees.
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Non-root runtime user; owns the mutable dirs.
RUN useradd --create-home --uid 10001 claude \
 && mkdir -p /data /workspaces \
 && chown -R claude /data /workspaces /app
USER claude

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WORKSPACES_DIR=/workspaces

VOLUME ["/data", "/workspaces"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
