# Tropic — GitLab → Claude Agent Service — Design

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
tropic/
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
├─ install.sh             # one-command Docker installer (curl | bash) — see §14
├─ Dockerfile             # agent container image — see §15
├─ docker-compose.yml     # agent + caddy services with persisted volumes
├─ Caddyfile              # TLS reverse proxy config (agent ← caddy)
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
    // Claude Code's real system prompt — this is what makes it Claude Code, not a
    // bare model with tools.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],        // load repo CLAUDE.md / .claude config
    permissionMode: "bypassPermissions",// fully autonomous (safe: isolated container)
    allowDangerouslySkipPermissions: true,
    // No allowedTools cap → the full default toolset (incl. TodoWrite, Task, WebFetch…).
    // No maxTurns → runs until the task is actually done.
    // model: from ANTHROPIC_MODEL if set, else the SDK default.
  },
})) {
  // stream to logs; capture final result + token usage
}
```

Notes:

- **`cwd` = the isolated worktree** so Claude only sees that repo.
- `CLAUDE.md` at repo root carries coding standards — Claude reads it automatically.
- **No turn cap.** The agent runs to completion; the only guard is the wall-clock
  `JOB_TIMEOUT_MS` (default 30 min, set `0` to disable). Isolation (container + worktree)
  is what bounds blast radius, not a turn/permission limit.

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
| Comment on MR (ack + reply on `@mention`) | `POST /projects/:id/merge_requests/:iid/notes` |

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

- **Install:** one command on a fresh Ubuntu VM — see **§14**. Deployment is **Docker only**
  (`docker compose`): an `agent` container plus a `caddy` container for TLS. There is no
  native/systemd path.
- **Process supervision:** Docker (`restart: unless-stopped`). The agent reads its config
  from `tropic.env` (compose `env_file`).
- **Privileges:** the agent runs as **root inside its container** so Claude's Bash tool can
  install packages and build/test with a writable `HOME` and `/tmp`. The container — not
  dropped privileges — is the isolation boundary; the host is untouched.
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
tiers. See §14.2. Use `--bot-token` (supply a pre-made token, doing steps 1–2 yourself) as
the alternative.

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
4. **Follow-ups** — ✅ **implemented.** `@claude-bot` in an MR comment (Note Hook) makes the
   bot check out that MR's branch, act on the comment, push to the same branch, and reply.
   The installer enables both **Issues** and **Comments** webhook triggers.
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
8. README + hardening pass.
9. `install.sh` + `Dockerfile` + `docker-compose.yml` + `Caddyfile` (§14, §15).

---

## 14. Stupid-simple install (fresh Ubuntu VM)

**Design goal:** get from a blank Ubuntu 22.04/24.04 VM to a running, webhook-ready
service with **one command** the operator pastes into an SSH session. The script is
idempotent (safe to re-run), interactive only where a human decision is unavoidable
(secrets), and prints the exact GitLab-side steps it cannot do itself — then waits for
`ENTER` before finishing.

Deployment is **Docker only** — an `agent` container plus a `caddy` container for TLS.

### 14.1 The one command

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh | sudo bash
```

Pass flags through a piped run with `-s --`, e.g.
`… | sudo bash -s -- --domain agent.example.com --project group/repo`.

### 14.2 What `install.sh` does

Runs as root; fails fast (`set -euo pipefail`) with a clear message on any error.

1. **Preflight** — confirm Ubuntu + apt.
2. **System packages** — `git curl ca-certificates openssl jq` (for the clone + the GitLab
   provisioning API calls).
3. **Clean up legacy** — remove any old native systemd unit / host Caddy that would fight the
   containers for ports 80/443/8080.
4. **Fetch the app** — clone the repo (pinned `--ref`, default `main`) into
   `/opt/tropic`.
5. **Interactive config** — if `/etc/tropic.env` doesn't exist, prompt and write
   it `chmod 600`:
   - `GITLAB_BASE_URL`
   - **Bot identity — a regular bot user by default (works on all tiers).** Prompts for a
     one-time **admin token**, then calls the admin API to create a regular user
     (`POST /users`) and an `api`-scoped token for it
     (`POST /users/:id/personal_access_tokens`). The admin token is used only during install
     and is **never written to disk**; only the resulting bot token is persisted as
     `GITLAB_BOT_TOKEN`, with `CLAUDE_BOT_USERNAME` set to the created username. `--bot-token`
     skips creation and prompts for a pre-made `GITLAB_BOT_TOKEN` + `CLAUDE_BOT_USERNAME`.
   - `ANTHROPIC_API_KEY`  (input hidden)
   - `GITLAB_WEBHOOK_SECRET` — **auto-generated** with `openssl rand -hex 32`.
   - `SITE_ADDRESS` — set from `--domain` (auto-HTTPS) or `:80` (plain HTTP); drives Caddy.
6. **Deploy** — install Docker Engine if absent, then `docker compose up -d --build` to start
   the `agent` + `caddy` containers. Verify `GET /healthz` (agent bound on `127.0.0.1:8080`).
7. **Wire GitLab** — `--group`/`--project` add the bot as a member and (for projects) create
   or update the Issues webhook via the API, using the one-time admin token.
8. **Print checklist + pause** — print any remaining manual GitLab steps (filled with this
   VM's URL + secret), block on `ENTER`, then run a self-test (`/healthz` + bot token valid).

### 14.3 The GitLab-side checklist the script prints

If `--project` fully wired everything, the checklist just says *"All set."* Otherwise it
prints the remaining manual steps:

```
════════════════════════ GitLab setup ════════════════════════
 1. Done for you: bot "claude-bot" and its api token were created.
      → Add "claude-bot" as Developer to each target project (or group).
 2. In each project (or group):  Settings → Webhooks → Add webhook
      URL:           https://<DOMAIN>/webhook   (or http://<VM_IP>/webhook)
      Secret token:  <GENERATED_WEBHOOK_SECRET>
      Trigger:       ☑ Issues events   (leave everything else unchecked)
      SSL verify:    ☑ if you used --domain
 3. (Optional) Add a CLAUDE.md to each repo with your coding standards.
═══════════════════════════════════════════════════════════════
```

**Wiring flags** (use the one-time admin token, idempotent, re-run-safe):
- `--project <id|group/repo>` — add the bot as **Developer** on the project
  (`POST /projects/:id/members`) and **create or update** its Issues webhook
  (`POST`/`PUT /projects/:id/hooks`). The update path re-syncs the secret, so a rotated
  `GITLAB_WEBHOOK_SECRET` can't drift out of sync.
- `--group <id|group/repo>` — add the bot as **Developer** on a whole group
  (`POST /groups/:id/members`), granting access to every project in it. Webhooks stay
  per-project (group webhooks are a Premium feature and aren't used here).

### 14.4 Uninstall

`install.sh --uninstall` stops + removes the containers but **keeps** the repo
(`/opt/tropic`), config (`/etc/tropic.env`), and Docker volumes —
so a reinstall is just `sudo bash /opt/tropic/install.sh`, no re-clone or
re-provisioning.

`--purge` (with `--uninstall`) is the full wipe: repo, config, and Docker volumes. It
re-execs from `/tmp` first so it can safely delete the app dir containing the script.

Updating is `git pull` + `docker compose up -d --build` in `/opt/tropic`.

---

## 15. Docker

Deployment runs two containers via `docker-compose.yml`:

- **`agent`** — the Node service. Built from the multi-stage `Dockerfile` (compile TS in a
  full image, run on a slim base). Runs as **root** with a writable `HOME` and build tooling
  (`build-essential`, `python3`, `git`, `curl`, the Claude Code CLI) so Claude's Bash tool
  can install packages and build/test freely. Bound to `127.0.0.1:8080` (not public).
- **`caddy`** — `caddy:2`, publishes `:80`/`:443`, reverse-proxies to `agent:8080`. Its site
  address comes from `SITE_ADDRESS` (a domain → auto Let's Encrypt cert; `:80` → plain HTTP),
  driven by the `Caddyfile`.

### 15.1 Notes

- **Persisted state:** named volumes — `claude-data` (`/data` queue), `claude-workspaces`
  (`/workspaces` repo mirrors), and `caddy-data`/`caddy-config` (certs) — survive restarts
  and image rebuilds.
- **Isolation:** the container, not dropped in-container privileges, is the boundary; the
  host is untouched. For many-repo deployments, a future step is per-job ephemeral child
  containers (§12 open question 2).
