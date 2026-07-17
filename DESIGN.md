# GitLab → Claude Agent Service — Design

A long-running service on a dedicated VM that listens to GitLab webhooks and, when an
issue is **assigned to the "Claude" bot user**, runs Claude (via the Claude Agent SDK)
against a working checkout of the repo, then pushes a branch and opens a merge request.

**Not** GitLab CI. A persistent Node process with Claude Code + git pre-installed.

- **Runtime:** TypeScript / Node
- **Trigger:** Issue assigned to the Claude bot user
- **API auth:** `ANTHROPIC_API_KEY`
- **Status:** design — code to follow after approval

---

## 1. High-level flow

```
GitLab (self-hosted)
  │  Issue Hook  (action = "update", assignee includes Claude bot)
  ▼
┌──────────────────────────── Dedicated VM ────────────────────────────┐
│                                                                       │
│  [1] Webhook server (Express)                                         │
│       - verify X-Gitlab-Token (constant-time compare)                 │
│       - parse Issue Hook payload                                       │
│       - filter: is this an "assigned to Claude" transition?           │
│       - dedupe (issue iid + assignment) → enqueue job                 │
│       - respond 200 immediately                                       │
│                                                                       │
│  [2] Job queue (in-process, persisted to disk)                        │
│       - bounded concurrency (e.g. 2 workers)                          │
│                                                                       │
│  [3] Worker (per job)                                                 │
│       a. post "👋 on it" comment on the issue                         │
│       b. prepare isolated git worktree for the repo                   │
│       c. create branch  claude/issue-<iid>-<slug>                     │
│       d. run Claude Agent SDK query(prompt = issue title+body)        │
│          - Claude edits files, runs tests, iterates                   │
│       e. if changes: commit, push branch                              │
│       f. open MR (source=branch, target=default), link issue          │
│       g. post result comment (MR link, or "no changes / failed")      │
│                                                                       │
│  Pre-installed: node, git, claude code, project toolchains            │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2. Why a queue (not inline)

GitLab expects webhook handlers to return quickly; a Claude run takes minutes. So the
HTTP handler does only validation + enqueue + `200`. A separate worker loop drains the
queue with bounded concurrency. The queue is persisted to disk (a simple SQLite
file) so an in-flight backlog survives a process restart.

---

## 3. Trigger semantics — "assigned to Claude"

GitLab **Issue Hook** payloads (`object_kind: "issue"`) include `assignees` and
`changes`. A clean assignment transition looks like:

```jsonc
{
  "object_kind": "issue",
  "object_attributes": { "iid": 42, "action": "update", "title": "...", "description": "..." },
  "assignees": [{ "username": "claude-bot" }],
  "changes": {
    "assignees": {
      "previous": [],
      "current": [{ "username": "claude-bot" }]
    }
  }
}
```

**Fire only when** `changes.assignees.current` newly contains the Claude bot AND
`changes.assignees.previous` did not. This avoids re-firing on unrelated edits to an
issue that already has Claude assigned.

**Dedupe key:** `${project_id}:${issue_iid}:assigned`. If a job for that key is already
queued or running, drop the duplicate. (Guards against webhook retries / rapid re-assign.)

---

## 4. Components & files

```
gitlab-claude-agent/
├─ src/
│  ├─ index.ts            # boot: config, start server + worker loop
│  ├─ config.ts           # env parsing & validation (zod)
│  ├─ server.ts           # Express app, /webhook route, token verify
│  ├─ webhook.ts          # payload parsing + "assigned to Claude" filter
│  ├─ queue.ts            # persistent job queue + concurrency control
│  ├─ worker.ts           # the per-job pipeline (git → claude → MR)
│  ├─ git.ts              # clone/fetch, worktree, branch, commit, push
│  ├─ gitlab.ts           # GitLab client (wraps @gitbeaker/rest SDK)
│  ├─ claude.ts           # Claude Agent SDK invocation wrapper
│  └─ log.ts              # structured logging (pino)
├─ workspaces/            # per-repo checkouts (gitignored)
├─ data/queue.json        # persisted queue state (gitignored)
├─ .env.example
├─ install.sh             # one-command installer (curl | bash) — see §14
├─ update.sh              # pull + rebuild + redeploy + restart
├─ Dockerfile             # container image — see §15
├─ docker-compose.yml     # one-command run with a persisted volume
├─ systemd/gitlab-claude-agent.service
├─ package.json
└─ README.md
```

---

## 5. The Claude step (Agent SDK)

Uses `@anthropic-ai/claude-agent-sdk` in headless mode inside the worktree. Sketch:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = [
  `You are implementing a GitLab issue.`,
  `# Issue #${issue.iid}: ${issue.title}`,
  ``,
  issue.description ?? "(no description)",
  ``,
  `Implement the change in this repository. Follow CLAUDE.md if present.`,
  `Run the project's tests before finishing. Do not touch unrelated files.`,
].join("\n");

for await (const msg of query({
  prompt,
  options: {
    cwd: worktreeDir,
    permissionMode: "acceptEdits",     // no interactive prompts
    allowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
    maxTurns: 40,                       // cost/time guard
    // model defaults to latest; override via env if needed
  },
})) {
  // stream to logs; capture final result + token usage
}
```

Notes:

- **`cwd` = the isolated worktree** so Claude only sees that repo.
- `CLAUDE.md` at repo root carries coding standards — Claude reads it automatically.
- Guard rails: `maxTurns`, an overall wall-clock timeout, and `allowedTools` scoped to
  what's needed (no network tools by default).

---

## 6. Git strategy

- One **bare mirror clone** per project under `workspaces/<project>/.git-mirror`, updated
  with `git fetch` per job (fast; avoids re-cloning large repos).
- Each job gets a fresh **`git worktree add`** off the default branch → concurrent jobs
  never collide.
- Branch name: `claude/issue-<iid>-<short-slug>`.
- Commit author = the Claude bot identity; message references the issue (`Closes #<iid>`).
- Push over HTTPS using the bot token: `https://claude-bot:<TOKEN>@gitlab.example.com/...`.
- Worktree is removed after the job (success or failure).

---

## 7. GitLab API usage (bot token, `api` scope)

| Action | Endpoint |
|---|---|
| Comment on issue | `POST /projects/:id/issues/:iid/notes` |
| Open MR | `POST /projects/:id/merge_requests` |
| Comment on MR (optional) | `POST /projects/:id/merge_requests/:iid/notes` |

API calls go through the official **`@gitbeaker/rest`** SDK (not a hand-rolled client).
MR body links the issue and includes a short summary of what Claude did + token usage.
Branch protection, required approvals, and existing CI still gate the merge — the service
never merges anything itself.

---

## 8. Configuration (`.env`)

```
PORT=8080
GITLAB_BASE_URL=https://gitlab.example.com
GITLAB_WEBHOOK_SECRET=<random, matches webhook "Secret token">
GITLAB_BOT_TOKEN=<personal/project access token, api scope>
CLAUDE_BOT_USERNAME=claude-bot
ANTHROPIC_API_KEY=<key>
MAX_CONCURRENCY=2
JOB_TIMEOUT_MS=1800000
WORKSPACES_DIR=./workspaces
```

---

## 9. Security

- **Webhook auth:** GitLab sends the configured secret in `X-Gitlab-Token`; verify with a
  constant-time compare. Reject anything else. Terminate TLS in front (nginx/caddy) or in-app.
- **Token scope:** the bot token should be a project/group token with only `api` scope,
  limited to the repos you want automated.
- **Blast radius:** Claude runs with `acceptEdits` and can execute Bash in the worktree —
  treat the VM as capable of arbitrary code execution on those repos. Run it as an
  unprivileged user, ideally in a container or firejail, on an isolated network segment.
  Consider an allowlist of projects the service will act on.
- **Secrets:** never let the issue text override auth; tokens come only from env.

---

## 10. Operations

- **Install:** one command on a fresh Ubuntu VM — see **§14**. Two supported deployment
  shapes: (a) native install under `systemd`, (b) Docker container. §14 covers both.
- **Process supervision:** `systemd` unit (provided) — `Restart=always`, runs as a
  dedicated `claude-agent` user, `EnvironmentFile=/etc/gitlab-claude-agent.env`.
- **Sandboxing is intentionally light in the native unit.** Claude executes arbitrary
  build/test commands in the worktree and needs free filesystem access (a writable `HOME`
  for `~/.claude` + toolchain caches, `/tmp`, the repo). So the unit keeps only
  `NoNewPrivileges` + `PrivateTmp` + the unprivileged user; it does **not** set
  `ProtectHome`/`ProtectSystem`/`ReadWritePaths` (those disable the agent's Bash tool). If
  you need real isolation, run the Docker image or per-job containers (§9, §15) rather than
  tightening the systemd unit — a locked-down unit and a working agent are at odds.
- **Logging:** structured JSON (pino) → journald; one correlation id per job.
- **Health:** `GET /healthz` for a load balancer / uptime check.
- **Backpressure:** if the queue exceeds a threshold, new webhooks still 200 but the job
  posts a "queued, N ahead" comment so users aren't confused by the delay.
- **Failure UX:** on error, post a comment with a short reason + a pointer to logs; never
  leave the issue silently unhandled.

---

## 11. GitLab-side setup (one time)

The bot identity is a **regular GitLab user** by default — the installer creates it and its
`api`-scoped token for you from a one-time admin token (never stored), which works on all
tiers. See §14.2. Use `--service-account` (Premium) or `--bot-token` (do steps 1–2 yourself)
as alternatives.

1. *(auto / manual)* A bot identity (`claude-bot`) with an `api`-scoped token. Add it to
   target projects (or the group) as **Developer** so it can be assigned issues + push.
2. *(auto / manual)* The `api`-scoped token → `GITLAB_BOT_TOKEN`.
3. In each project (or group): **Settings → Webhooks** →
   - URL: `https://vm.example.com/webhook`
   - Secret token: matches `GITLAB_WEBHOOK_SECRET`
   - Trigger: **Issues events** (only)
   - Enable SSL verification.
4. Add a `CLAUDE.md` to each repo with coding standards (optional but recommended).

---

## 12. Open questions / decisions to confirm before building

1. **Concurrency & sizing** — how many repos, expected issue volume? Sets `MAX_CONCURRENCY`
   and VM specs.
2. **Sandboxing level** — bare process, Docker-per-job, or firejail? (Recommend
   Docker-per-job for isolation if you'll point this at many repos.)
3. **Queue backend** — in-process + JSON file is fine to start; move to Redis/BullMQ if you
   want multi-VM or durable retries later.
4. **Follow-ups** — do you also want `@claude` comment replies to iterate on an open MR, or
   is first-pass issue → MR enough for v1? (Design leaves room; v1 can be assignment-only.)
5. **Model** — pin a specific Claude model, or track latest?

---

## 13. Build plan (once approved)

1. Scaffold repo + config + logging + `/healthz`.
2. Webhook route with token verify + "assigned to Claude" filter (+ unit tests on sample
   payloads).
3. Persistent queue + bounded worker loop.
4. Git module (mirror, worktree, branch, push) against a throwaway test repo.
5. GitLab client (comment, open MR).
6. Claude Agent SDK integration + guard rails.
7. End-to-end dry run on one test project.
8. systemd unit + README + hardening pass.
9. `install.sh` + `Dockerfile` + `docker-compose.yml` (§14, §15).

---

## 14. Stupid-simple install (fresh Ubuntu VM)

**Design goal:** get from a blank Ubuntu 22.04/24.04 VM to a running, webhook-ready
service with **one command** the operator pastes into an SSH session. The script is
idempotent (safe to re-run), interactive only where a human decision is unavoidable
(secrets), and prints the exact GitLab-side steps it cannot do itself — then waits for
`ENTER` before finishing.

**Deployment default: Docker.** The container is the isolation boundary, so the agent runs
with full privileges inside it — Claude can install packages, build, and test without the
host sandbox/permission problems an unprivileged systemd service hits. `--native` selects
the systemd path instead (unprivileged; no `sudo` in repo builds).

### 14.1 The one command

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh | sudo bash
```

That's it. For the security-conscious, the equivalent two-step (inspect, then run):

```bash
curl -fsSL https://.../install.sh -o install.sh && less install.sh && sudo bash install.sh
```

### 14.2 What `install.sh` does

Runs as root; fails fast (`set -euo pipefail`) with a clear message on any error.

1. **Preflight** — confirm Ubuntu + apt, x86_64/arm64, outbound network. Refuse politely
   on unsupported distros with a pointer to the Docker path (§15).
2. **System packages** — `apt-get update && apt-get install -y git curl ca-certificates`.
   Install Node.js LTS from NodeSource (or nvm-less system Node) and `nodejs`+`npm`.
3. **Dedicated user** — create unprivileged `claude-agent` user + `/opt/gitlab-claude-agent`
   home; never run the service as root.
4. **Fetch the app** — clone the repo (pinned tag/`main`) into `/opt/gitlab-claude-agent`,
   `npm ci --omit=dev`, `npm run build`.
5. **Interactive config** — if `/etc/gitlab-claude-agent.env` doesn't exist, prompt for the
   handful of required values and write it `chmod 600`, owned by `claude-agent`:
   - `GITLAB_BASE_URL`
   - **Bot identity — a regular bot user by default (works on all tiers).** The installer
     prompts for a one-time **admin token**, then calls the admin API to create a regular
     user (`POST /users`) and an `api`-scoped token for it
     (`POST /users/:id/personal_access_tokens`). The admin token is used only during install
     and is **never written to disk**; only the resulting bot token is persisted as
     `GITLAB_BOT_TOKEN`, and `CLAUDE_BOT_USERNAME` is set to the created username. Alternatives:
     `--service-account` uses the service-accounts API instead (needs Premium/Ultimate);
     `--group <id>` makes a group service account (needs group Owner + Premium); `--bot-token`
     skips creation and prompts for a pre-made `GITLAB_BOT_TOKEN` + `CLAUDE_BOT_USERNAME`.
   - `ANTHROPIC_API_KEY`  (input hidden)
   - `GITLAB_WEBHOOK_SECRET` — **auto-generated** with `openssl rand -hex 32` if left blank
     (script echoes the generated value so the operator can paste it into GitLab).
   Non-interactive mode: honor these same vars if already present in the environment, so
   the script works in cloud-init / Ansible with zero prompts.
6. **Install the systemd unit** — drop `gitlab-claude-agent.service`, `systemctl
   daemon-reload`, `enable --now`. Verify it reached `active (running)` and that
   `GET /healthz` returns 200; otherwise dump the last 20 journald lines and exit non-zero.
7. **Print GitLab-side setup + pause** — print the exact, copy-pasteable checklist below,
   filled in with this VM's values (public URL/IP, the webhook secret), then:

   ```
   ⏸  Complete the GitLab steps above, then press ENTER to run a connectivity self-test…
   ```

   The script blocks on `read` until the operator confirms.
8. **Self-test** — after ENTER, optionally hit the GitLab API with the bot token to confirm
   the token is valid and has `api` scope; report ✅/❌. Print the service status, log
   command (`journalctl -u gitlab-claude-agent -f`), and the webhook URL. Done.

### 14.3 The GitLab-side checklist the script prints

The bot user + token are created automatically (default mode). What remains is adding that
user to the projects and wiring the webhook — steps that need a human in the GitLab UI (the
installer doesn't know which projects to target). So `install.sh` prints:

```
════════════════════════ GitLab setup (do this now) ════════════════════════
1. Done for you: bot user "claude-bot" and its api token were created.
      → Add "claude-bot" to each target project (or group) as Developer
        (Members → Invite) so it can be assigned issues and push branches.
2. In each project (or the group):  Settings → Webhooks → Add webhook
      URL:           http://<THIS_VM_PUBLIC_URL>/webhook
      Secret token:  <GENERATED_WEBHOOK_SECRET>
      Trigger:       ☑ Issues events     (leave everything else unchecked)
      SSL verify:    ☑ (recommended — put a TLS proxy in front, see README)
3. (Optional) Add a CLAUDE.md to each repo with your coding standards.
═════════════════════════════════════════════════════════════════════════════
```

(With `--service-account` step 1 creates a service account instead; with `--bot-token` it
reminds you to create the bot user + token yourself.)

**Fully hands-off:** pass `--project <id|group/repo>` (repeatable) and the installer, while
it still holds the one-time admin token, adds the bot to that project as **Developer** and
creates the **Issues webhook** via the API (`POST /projects/:id/members` and
`POST /projects/:id/hooks`) — idempotently (existing webhooks with the same URL are left
alone). With `--project`, steps 1–2 of the checklist are done automatically and nothing is
left to do in the GitLab UI.

> TLS note: for `https://` webhooks with SSL verification, run a reverse proxy (Caddy gets
> you an auto-Let's-Encrypt cert in ~2 lines). The installer can offer to set this up when a
> `--domain <fqdn>` flag is passed; otherwise it defaults to plain `:8080` and tells the
> operator to front it themselves.

### 14.4 Uninstall

`install.sh --uninstall` stops+disables the unit, removes the app dir, and (with
confirmation) the `claude-agent` user, leaving `/etc/gitlab-claude-agent.env` in place
unless `--purge` is also given.

---

## 15. Docker

For operators who'd rather not touch the host, a container is the fastest path and also the
recommended isolation boundary (§9 blast radius). The image bundles Node, git, and the
Claude Code CLI so a job's Bash calls have a toolchain available.

### 15.1 Dockerfile (sketch)

Multi-stage: build TypeScript in a full image, run on a slim base as a non-root user.

```dockerfile
# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build          # → dist/

# ---- runtime stage ----
FROM node:22-bookworm-slim
# git is required for the worktree pipeline; ca-certificates for HTTPS push/API
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI available for the agent's Bash tool
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# non-root
RUN useradd --create-home --uid 10001 claude \
 && mkdir -p /data /workspaces && chown -R claude /data /workspaces /app
USER claude
ENV NODE_ENV=production \
    PORT=8080 \
    WORKSPACES_DIR=/workspaces
VOLUME ["/data", "/workspaces"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||8080) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
```

### 15.2 Run it

```bash
docker run -d --name gitlab-claude-agent \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file gitlab-claude-agent.env \
  -v claude-data:/data \
  -v claude-workspaces:/workspaces \
  ghcr.io/<org>/gitlab-claude-agent:latest
```

Or via `docker-compose.yml` (`docker compose up -d`):

```yaml
services:
  agent:
    image: ghcr.io/<org>/gitlab-claude-agent:latest
    restart: unless-stopped
    ports: ["8080:8080"]
    env_file: gitlab-claude-agent.env
    volumes:
      - claude-data:/data
      - claude-workspaces:/workspaces
volumes:
  claude-data:
  claude-workspaces:
```

### 15.3 Notes

- **Persisted state:** `/data` (queue) and `/workspaces` (repo mirrors) are named volumes so
  the queue backlog and cached clones survive `docker restart`/image upgrades.
- **`install.sh` (Docker is the default):** installs Docker Engine if absent, writes the
  `.env`, builds the image, and starts the compose stack, then prints the GitLab checklist +
  ENTER pause (§14.3). `--native` switches to the systemd path.
- **Runs as root inside the container.** The container is the isolation boundary, so the
  agent runs privileged within it — Claude's Bash can install packages and build/test freely,
  with a writable `HOME` (`~/.claude` + toolchain caches). The host is protected by the
  container, not by dropping privileges inside it.
- **Per-job isolation (future):** §12 open question 2 — for many-repo deployments, run each
  job in an ephemeral child container so a repo's Bash can't see the service or other repos.
