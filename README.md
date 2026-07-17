# gitlab-claude-agent

A long-running service that watches GitLab for issues **assigned to a Claude bot user**,
runs Claude (via the Claude Agent SDK) against a checkout of the repo, and opens a merge
request with the result.

See [`DESIGN.md`](./DESIGN.md) for the full design.

## Quick start (fresh Ubuntu VM)

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/gitlab-claude-agent/main/install.sh | sudo bash
```

The installer sets up Node, a dedicated user, the systemd service, and your config, then
**prints the GitLab-side checklist and waits for you to press ENTER** before running a
connectivity self-test. See `DESIGN.md` §14 for details and flags:

- `--docker` — run as a container instead of a native systemd service
- `--domain example.com` — provision a Caddy TLS reverse proxy
- `--uninstall [--purge]` — remove the service

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
