# gitlab-claude-agent

A long-running service that watches GitLab for issues **assigned to a Claude bot user**,
runs Claude (via the Claude Agent SDK) against a checkout of the repo, and opens a merge
request with the result.

See [`DESIGN.md`](./DESIGN.md) for the full design.

## Quick start (fresh Ubuntu VM)

Native (systemd) install, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh \
  | sudo bash -s -- --repo https://github.com/sharpvik/tropic.git
```

`bash -s --` passes the flags through to the piped script. The installer sets up Node, a
dedicated `claude-agent` user, the systemd service, and your config, then **prints the
GitLab-side checklist and waits for you to press ENTER** before running a connectivity
self-test.

### Bot identity: auto-created bot user (default)

By default the installer **creates a regular GitLab user for the bot and an `api`-scoped
token for it** — this works on **all GitLab tiers** (Free/CE included). It prompts once for
a GitLab **admin token**, calls the admin API (`POST /users` then
`POST /users/:id/personal_access_tokens`), then discards the admin token (only the resulting
bot token is persisted). You'll be prompted for:

- `GITLAB_BASE_URL`
- a one-time **admin token** (not stored) + the bot's display name / username / email
- `ANTHROPIC_API_KEY`

(the webhook secret is auto-generated). Requires an **instance admin** token. If you don't
have one, supply a pre-made token with `--bot-token` instead (you'll be asked for
`GITLAB_BOT_TOKEN` + `CLAUDE_BOT_USERNAME`). If you're on Premium/Ultimate and prefer a
service account, use `--service-account` (or `--group <id>` for a group-level one).

Flags (see `DESIGN.md` §14):

- `--bot-token` — supply a pre-made api-scoped token instead of creating the bot user
- `--service-account` — create a service account (needs GitLab Premium/Ultimate)
- `--group <id>` — create a group-level service account (implies `--service-account`)
- `--repo <git-url>` — source repo to clone (defaults to a placeholder; set this)
- `--ref <git-ref>` — branch/tag to install (default `main`)
- `--domain example.com` — provision a Caddy TLS reverse proxy + real cert
- `--docker` — run as a container instead of a native systemd service
- `--uninstall [--purge]` — remove the service

### Get HTTPS for the webhook

Without `--domain`, the service listens on plain `:8080` and the checklist prints an
`http://<vm-ip>:8080/webhook` URL — usable, but you must **uncheck "SSL verification"** on
the GitLab webhook. To get HTTPS with an automatic Let's Encrypt cert, point a DNS record at
the VM first, then:

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh \
  | sudo bash -s -- --repo https://github.com/sharpvik/tropic.git --domain agent.example.com
```

### If the repo is private

Both the `curl` of `install.sh` and the `git clone` inside it need auth. Either make the
repo public, embed a token in the clone URL (`--repo https://<token>@github.com/sharpvik/tropic.git`),
or copy the files to the VM and run the script from a local path:

```bash
scp -r ./tropic user@vm:/tmp/tropic
ssh user@vm 'sudo REPO_URL=/tmp/tropic bash /tmp/tropic/install.sh'
```

### Manage the service

```bash
journalctl -u gitlab-claude-agent -f    # logs
systemctl restart gitlab-claude-agent   # restart
```

## VM sizing

The service itself is tiny (~200–400 MB RAM, near-zero idle CPU). The real load is
per-job: Claude runs the target repo's installs, builds, and **test suite** inside a
worktree — i.e. CI-runner load, `MAX_CONCURRENCY` of them at once.

| Config | vCPU | RAM | Disk |
|---|---|---|---|
| Light (concurrency 1–2, small repos) | 2 | 4 GB | 20 GB |
| **Recommended default (concurrency 2)** | **4** | **8 GB** | **40 GB** |
| Heavy (concurrency 4, or big monorepos) | 8 | 16 GB | 80–160 GB |

Rule of thumb: `RAM ≈ 1 GB + MAX_CONCURRENCY × (peak RAM of one build+test run)`. Prefer
more RAM over vCPU (OOM mid-build fails jobs; CPU starvation just slows them), add ~2 GB
swap, and note that a stuck job holds its slot for the full `JOB_TIMEOUT_MS` (default 30 min).

## Run with Docker

```bash
cp .env.example gitlab-claude-agent.env   # fill it in
docker compose up -d --build
```

State (`/data` queue, `/workspaces` repo mirrors) lives in named volumes and survives
restarts.

## Local development

```bash
npm install
cp .env.example .env        # fill in required values
npm run dev                 # tsx watch
npm test                    # vitest
npm run typecheck
npm run build && npm start
```

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example).
Required: `GITLAB_BASE_URL`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_BOT_TOKEN`,
`ANTHROPIC_API_KEY`.

## How it works

1. GitLab sends an **Issue Hook** to `POST /webhook` (secret verified in constant time).
2. The handler filters for the *false→true* transition of the Claude bot being assigned,
   dedupes, enqueues, and returns immediately.
3. A bounded-concurrency worker prepares a git worktree, runs the Claude Agent SDK inside
   it, commits + pushes any changes, opens an MR, and comments the result back on the issue.

The GitLab API is accessed through the official [`@gitbeaker/rest`](https://github.com/jdalrymple/gitbeaker)
SDK. The service never merges anything — CI, branch protection, and approvals still gate the
merge.

## Endpoints

| Method | Path        | Purpose                          |
|--------|-------------|----------------------------------|
| `GET`  | `/healthz`  | Liveness + queue depth           |
| `POST` | `/webhook`  | GitLab Issue Hook receiver       |

## Testing

`npm test` runs the vitest suite covering config validation, the webhook assignment filter,
the persistent queue (dedupe, concurrency, crash recovery), the GitLab client, the webhook
server, and the worker pipeline (with mocked git/GitLab/Claude).
