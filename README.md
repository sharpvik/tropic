# tropic

A long-running service that watches GitLab for issues **assigned to a Claude bot user**,
runs Claude (via the Claude Agent SDK) against a checkout of the repo, and opens a merge
request with the result.

See [`DESIGN.md`](./DESIGN.md) for the full design.

## Quick start (fresh Ubuntu VM)

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh | sudo bash
```

It deploys with **Docker Compose** — installs Docker if needed, builds the image, provisions
your config, and starts two containers: the **agent** (runs Claude with full privileges
inside its sandbox, so it can build/test freely — install packages, write caches — without
host permission issues) and **Caddy** (terminates TLS and reverse-proxies to the agent).
Then it **prints the GitLab-side checklist and waits for you to press ENTER** before a
connectivity self-test. (To pass flags through a piped run, append `-s -- <flags>`, e.g.
`… | sudo bash -s -- --domain agent.example.com --project group/repo`.)

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
`GITLAB_BOT_TOKEN` + `CLAUDE_BOT_USERNAME`).

Flags (see `DESIGN.md` §14):

- `--bot-token` — supply a pre-made api-scoped token instead of creating the bot user
- `--project <id|group/repo>` — add the bot as Developer to a project **and** create/update
  its Issues webhook (repeatable). With this, the install is fully hands-off.
- `--group <id|group/repo>` — add the bot as a Developer member of a whole group, granting
  access to every project in it (repeatable). Webhooks are still per-project (`--project`).
- `--domain example.com` — serve HTTPS for this domain via the Caddy container (auto cert)
- `--ref <git-ref>` — branch/tag to install (default `main`)
- `--uninstall [--purge]` — remove the deployment

### Get HTTPS for the webhook

Without `--domain`, Caddy serves plain HTTP on `:80` and the checklist prints an
`http://<vm-ip>/webhook` URL — usable, but you must **uncheck "SSL verification"** on the
GitLab webhook. To get HTTPS with an automatic Let's Encrypt cert, point a DNS record at the
VM first, then:

```bash
curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh \
  | sudo bash -s -- --domain agent.example.com
```

### If the repo is private

Both the `curl` of `install.sh` and the `git clone` inside it need auth. Either make the
repo public, set `REPO_URL` to a token-embedded clone URL, or copy the files to the VM and
run from a local path:

```bash
scp -r ./tropic user@vm:/tmp/tropic
ssh user@vm 'sudo REPO_URL=/tmp/tropic bash /tmp/tropic/install.sh'
```

### Manage the deployment

```bash
cd /opt/tropic
docker compose logs -f       # logs
docker compose restart       # restart
docker compose ps            # status
```

### Update to the latest version

```bash
cd /opt/tropic
sudo git pull
sudo docker compose --env-file /etc/tropic.env up -d --build
```

Pulls the latest code and rebuilds/restarts the containers. Your `.env` is untouched.

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
swap, and note that a stuck job holds its slot for the full `JOB_TIMEOUT_MS` (default 4h; `0` disables it).

## Run with Docker

```bash
cp .env.example tropic.env   # fill it in
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

Two triggers, both delivered to `POST /webhook` (secret verified in constant time):

1. **Issue assigned to the bot** — the handler fires on the *false→true* assignment
   transition (or an issue created already assigned), then a worker prepares a git worktree
   off the default branch, runs Claude, commits + pushes a new branch, opens an MR, and
   comments the result on the issue.
2. **`@claude-bot` mentioned in an MR comment** — the handler fires on an MR **Note Hook**
   that @-mentions the bot (ignoring the bot's own comments), then a worker checks out the
   MR's source branch, runs Claude against the comment, pushes the changes to that same
   branch, and replies on the MR.

Both paths dedupe (assignment by issue, comments by note id), run under bounded concurrency,
and the webhook returns immediately.

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
