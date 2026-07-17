#!/usr/bin/env bash
#
# gitlab-claude-agent — one-command installer for a fresh Ubuntu VM.
#
#   curl -fsSL https://raw.githubusercontent.com/your-org/gitlab-claude-agent/main/install.sh | sudo bash
#
# By default the installer CREATES a GitLab service account + api token for the bot,
# using a one-time admin token you provide (it is never stored). Use --bot-token to
# supply a pre-made token instead.
#
# Flags:
#   --bot-token         Supply a pre-made api-scoped token + username instead of
#                       auto-creating a service account.
#   --group <id>        Create a GROUP service account under this group id (needs
#                       Owner + Premium) instead of an instance-level one.
#   --docker            Install via Docker instead of a native systemd service.
#   --domain <fqdn>     Set up a Caddy TLS reverse proxy for this domain.
#   --repo <git-url>    Override the source repo to clone (native install).
#   --ref <git-ref>     Branch/tag to install (default: main).
#   --uninstall         Stop and remove the service.
#   --purge             With --uninstall, also remove config + data.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APP_NAME="gitlab-claude-agent"
APP_USER="claude-agent"
APP_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
REPO_URL="${REPO_URL:-https://github.com/your-org/gitlab-claude-agent.git}"
REPO_REF="main"
MODE="native"
DOMAIN=""
DO_UNINSTALL=0
DO_PURGE=0
# How the bot identity is obtained:
#   service-account (default) — installer creates a GitLab service account + token
#   token                     — you supply a pre-made api-scoped token + username
PROVISION_MODE="service-account"
GITLAB_GROUP_ID=""   # if set, create a group service account instead of instance-level

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
c_reset=$'\e[0m'; c_bold=$'\e[1m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_dim=$'\e[2m'; c_cyan=$'\e[36m'
info()  { echo "${c_green}==>${c_reset} $*"; }
warn()  { echo "${c_yellow}!!${c_reset} $*"; }
err()   { echo "${c_red}xx${c_reset} $*" >&2; }
die()   { err "$*"; exit 1; }
# Dim indented guidance line, printed before a prompt.
guide() { echo "   ${c_dim}$*${c_reset}"; }

need_root() { [ "$(id -u)" -eq 0 ] || die "Please run as root (use: sudo bash install.sh)"; }

# True when we have a terminal to interact with. Reads /dev/tty rather than stdin
# so `curl … | sudo bash` (where stdin is the pipe) still prompts interactively.
have_tty() { [ -r /dev/tty ]; }

# Read a value interactively unless it's already set in the environment.
# usage: prompt_var VAR "Prompt text" [default] [secret]
prompt_var() {
  local var="$1" prompt="$2" default="${3:-}" secret="${4:-}"
  local current="${!var:-}"
  if [ -n "$current" ]; then return; fi
  if ! have_tty; then
    # No terminal available: fall back to default or fail for required vars.
    [ -n "$default" ] && { printf -v "$var" '%s' "$default"; return; }
    die "$var is required but no TTY is available (set it in the environment)."
  fi
  local input
  if [ -n "$secret" ]; then
    read -r -s -p "${prompt}: " input < /dev/tty; echo
  else
    read -r -p "${prompt}${default:+ [$default]}: " input < /dev/tty
  fi
  printf -v "$var" '%s' "${input:-$default}"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --docker) MODE="docker" ;;
      --domain) DOMAIN="$2"; shift ;;
      --repo) REPO_URL="$2"; shift ;;
      --ref) REPO_REF="$2"; shift ;;
      --bot-token) PROVISION_MODE="token" ;;
      --group) GITLAB_GROUP_ID="$2"; shift ;;
      --uninstall) DO_UNINSTALL=1 ;;
      --purge) DO_PURGE=1 ;;
      *) die "Unknown flag: $1" ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight() {
  command -v apt-get >/dev/null 2>&1 || die "This installer targets Debian/Ubuntu (apt). For other distros use the Docker image."
  info "Preflight OK (apt-based system detected)."
}

install_base_packages() {
  info "Installing base packages (git, curl, ca-certificates, openssl, jq)…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git curl ca-certificates openssl gnupg jq >/dev/null
}

install_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
    info "Node $(node -v) already present."
    return
  fi
  info "Installing Node.js 22 LTS from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  info "Installed Node $(node -v)."
}

ensure_user() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    info "Creating service user '${APP_USER}'…"
    useradd --system --create-home --home-dir "/home/${APP_USER}" --shell /usr/sbin/nologin "$APP_USER"
  fi
}

fetch_app() {
  info "Fetching application into ${APP_DIR}…"
  # The app dir is owned by claude-agent but git runs here as root; whitelist it
  # so git doesn't refuse with "dubious ownership" on re-runs.
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  if [ -d "${APP_DIR}/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$REPO_REF"
    git -C "$APP_DIR" checkout -f "$REPO_REF"
    git -C "$APP_DIR" reset --hard "origin/${REPO_REF}" || true
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  fi
  mkdir -p "${APP_DIR}/workspaces" "${APP_DIR}/data"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
}

build_app() {
  info "Building (installing dev deps, compiling TypeScript)…"
  # Dev deps are needed to compile; the built dist/ then runs on --omit=dev deps.
  ( cd "$APP_DIR" && npm ci --silent && npm run build --silent && npm prune --omit=dev --silent )
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Call the GitLab API, capturing body + status separately so we can report real
# errors. Sets GL_BODY and GL_CODE. Never uses -f (which hides the response).
# usage: gl_api METHOD PATH TOKEN [curl args…]
GL_BODY=""; GL_CODE=""
gl_api() {
  local method="$1" path="$2" token="$3"; shift 3
  local raw
  raw="$(curl -sS -X "$method" -w $'\n__HTTP__%{http_code}' \
    --header "PRIVATE-TOKEN: ${token}" "$@" \
    "${GITLAB_BASE_URL%/}/api/v4${path}" 2>&1)" || true
  GL_CODE="${raw##*__HTTP__}"
  GL_BODY="${raw%$'\n'__HTTP__*}"
  case "$GL_CODE" in [0-9]*) ;; *) GL_CODE="000"; GL_BODY="$raw" ;; esac
}

# Extract a human-readable message from a GitLab error body.
gl_err_msg() {
  echo "$1" | jq -r '(.message // .error // .) | if type=="object" then tojson else tostring end' 2>/dev/null \
    | head -c 300
}

# Create a GitLab service account and an api-scoped token for it, using a
# one-time admin token that is NOT persisted anywhere. Sets GITLAB_BOT_TOKEN
# and CLAUDE_BOT_USERNAME on success.
provision_service_account() {
  local base="${GITLAB_BASE_URL%/}" admin sa_name sa_user sa_path sa_id
  echo
  info "Provisioning a GitLab service account (used once; the admin token is not stored)."
  echo
  guide "How to get an ADMIN token (you need an account with Administrator access):"
  guide "  1. Open:  ${base}/-/user_settings/personal_access_tokens"
  guide "     (or: top-right avatar → Edit profile → Access tokens)"
  guide "  2. Name it e.g. 'bootstrap', set an expiry (tomorrow is fine — it's one-time)."
  guide "  3. Tick the  ${c_bold}api${c_reset}${c_dim}  scope, click 'Create personal access token'."
  guide "  4. Copy the token shown (starts with 'glpat-') and paste it below."
  guide "Not an admin? Press Ctrl-C and re-run with  --group <id>  or  --bot-token."
  prompt_var GITLAB_ADMIN_TOKEN "GitLab ADMIN token (glpat-…, used once, not stored)" "" secret
  admin="$GITLAB_ADMIN_TOKEN"
  [ -n "$admin" ] || die "An admin token is required to create a service account (or re-run with --bot-token)."
  prompt_var SA_NAME     "Display name for the bot" "Claude"
  prompt_var SA_USERNAME "Username for the bot"     "claude-bot"
  sa_name="$SA_NAME"; sa_user="$SA_USERNAME"

  # Sanity-check the token first so we can give a precise error.
  gl_api GET /user "$admin"
  if [ "$GL_CODE" != "200" ]; then
    err "The admin token was rejected by ${base} (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
    err "Check the token value and that GITLAB_BASE_URL is correct."
    die "Re-run with --bot-token to supply a pre-made token instead."
  fi
  if [ -z "$GITLAB_GROUP_ID" ] && [ "$(echo "$GL_BODY" | jq -r '.is_admin // false')" != "true" ]; then
    err "That token works, but its user is NOT an instance administrator, which is required"
    err "to create an instance-level service account."
    die "Re-run with  --group <id>  (group Owner + Premium) or  --bot-token."
  fi

  # Instance-level by default; group-level when --group is given (needs Owner + Premium).
  if [ -n "$GITLAB_GROUP_ID" ]; then
    sa_path="/groups/${GITLAB_GROUP_ID}/service_accounts"
  else
    sa_path="/service_accounts"
  fi

  info "Creating service account '${sa_user}'…"
  gl_api POST "$sa_path" "$admin" \
    --data-urlencode "name=${sa_name}" --data-urlencode "username=${sa_user}"
  # Older GitLab (<16.1) doesn't accept name/username; retry with no body.
  if [ "$GL_CODE" = "400" ]; then
    warn "This GitLab version doesn't accept a custom username; creating with an auto-generated one."
    gl_api POST "$sa_path" "$admin"
  fi
  sa_id="$(echo "$GL_BODY" | jq -r '.id // empty' 2>/dev/null)"
  if [ -z "$sa_id" ]; then
    err "Could not create the service account (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
    case "$GL_CODE" in
      403) err "The token lacks the rights to create service accounts here." ;;
      404) err "The service-accounts API isn't available (GitLab < 15.4, or --group id wrong)." ;;
    esac
    die "Re-run with --bot-token to supply a pre-made token instead."
  fi
  CLAUDE_BOT_USERNAME="$(echo "$GL_BODY" | jq -r '.username')"
  info "Created service account '${CLAUDE_BOT_USERNAME}' (id ${sa_id})."

  info "Creating an api-scoped token for the service account…"
  local tok_path
  if [ -n "$GITLAB_GROUP_ID" ]; then
    tok_path="/groups/${GITLAB_GROUP_ID}/service_accounts/${sa_id}/personal_access_tokens"
  else
    tok_path="/service_accounts/${sa_id}/personal_access_tokens"
  fi
  gl_api POST "$tok_path" "$admin" \
    --data-urlencode "name=gitlab-claude-agent" --data-urlencode "scopes[]=api"
  GITLAB_BOT_TOKEN="$(echo "$GL_BODY" | jq -r '.token // empty' 2>/dev/null)"
  [ -n "$GITLAB_BOT_TOKEN" ] || die "Service account created but token generation failed (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
  info "Service account token created."
  # Scrub the admin token from the environment.
  unset GITLAB_ADMIN_TOKEN admin
}

GENERATED_SECRET=""
write_env() {
  if [ -f "$ENV_FILE" ]; then
    info "Config ${ENV_FILE} already exists; keeping it. (Delete it to reconfigure.)"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    GENERATED_SECRET="${GITLAB_WEBHOOK_SECRET:-}"
    return
  fi

  info "Collecting configuration…"
  echo
  guide "Your GitLab instance's base address — the URL you log into, no trailing path."
  guide "  e.g.  https://gitlab.example.com   (or https://gitlab.com for gitlab.com)"
  prompt_var GITLAB_BASE_URL "GitLab base URL"

  if [ "$PROVISION_MODE" = "service-account" ]; then
    provision_service_account
  else
    echo
    guide "How to get a bot access token (project or group access token, scope: api):"
    guide "  Project → Settings → Access tokens  (or Group → Settings → Access tokens)"
    guide "  Role: Developer, Scopes: api, then Create. Copy the 'glpat-…' value."
    guide "Creating that token also makes the bot user; use its username below"
    guide "  (shown in the project/group Members list, e.g. 'project_123_bot')."
    prompt_var GITLAB_BOT_TOKEN    "GitLab bot access token (glpat-…)" "" secret
    prompt_var CLAUDE_BOT_USERNAME "Bot's GitLab username" "claude-bot"
  fi

  echo
  guide "Your Anthropic API key — create one at:  https://console.anthropic.com/settings/keys"
  guide "  (starts with 'sk-ant-'). This is what pays for Claude's work."
  prompt_var ANTHROPIC_API_KEY "Anthropic API key (sk-ant-…)" "" secret

  if [ -z "${GITLAB_WEBHOOK_SECRET:-}" ]; then
    GITLAB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
    GENERATED_SECRET="$GITLAB_WEBHOOK_SECRET"
    info "Generated a webhook secret (shown in the GitLab checklist below)."
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
PORT=8080
GITLAB_BASE_URL=${GITLAB_BASE_URL}
GITLAB_WEBHOOK_SECRET=${GITLAB_WEBHOOK_SECRET}
GITLAB_BOT_TOKEN=${GITLAB_BOT_TOKEN}
CLAUDE_BOT_USERNAME=${CLAUDE_BOT_USERNAME}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
MAX_CONCURRENCY=2
JOB_TIMEOUT_MS=1800000
MAX_TURNS=40
WORKSPACES_DIR=${APP_DIR}/workspaces
DATA_DIR=${APP_DIR}/data
BOT_GIT_USERNAME=${CLAUDE_BOT_USERNAME}
BOT_GIT_EMAIL=${CLAUDE_BOT_USERNAME}@users.noreply.gitlab
EOF
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Wrote ${ENV_FILE} (chmod 600)."
}

# ---------------------------------------------------------------------------
# Native (systemd) install
# ---------------------------------------------------------------------------
install_service() {
  info "Installing systemd unit…"
  install -m 0644 "${APP_DIR}/systemd/${APP_NAME}.service" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable --now "$APP_NAME"
  sleep 2
  if ! systemctl is-active --quiet "$APP_NAME"; then
    err "Service failed to start. Last log lines:"
    journalctl -u "$APP_NAME" -n 20 --no-pager || true
    die "Aborting."
  fi
  # Health check
  local port; port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
  if curl -fsS "http://localhost:${port:-8080}/healthz" >/dev/null; then
    info "Service is active and /healthz responds."
  else
    warn "Service is active but /healthz did not respond yet; check logs."
  fi
}

# ---------------------------------------------------------------------------
# Docker install
# ---------------------------------------------------------------------------
install_docker_engine() {
  if command -v docker >/dev/null 2>&1; then
    info "Docker already installed."
    return
  fi
  info "Installing Docker Engine…"
  curl -fsSL https://get.docker.com | sh >/dev/null
}

install_docker() {
  install_docker_engine
  # Reuse the env file as the container's env_file.
  cp "$ENV_FILE" "${APP_DIR}/${APP_NAME}.env" 2>/dev/null || true
  info "Building and starting the container…"
  ( cd "$APP_DIR" && docker compose --env-file "$ENV_FILE" up -d --build )
  sleep 3
  local port; port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
  if curl -fsS "http://localhost:${port:-8080}/healthz" >/dev/null; then
    info "Container is up and /healthz responds."
  else
    warn "Container started but /healthz did not respond yet; run: docker compose logs -f"
  fi
}

# ---------------------------------------------------------------------------
# Optional TLS proxy
# ---------------------------------------------------------------------------
setup_caddy() {
  [ -n "$DOMAIN" ] || return
  info "Setting up Caddy TLS reverse proxy for ${DOMAIN}…"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:8080
}
EOF
  systemctl reload caddy || systemctl restart caddy
  info "Caddy is serving https://${DOMAIN} (auto Let's Encrypt cert)."
}

# ---------------------------------------------------------------------------
# GitLab checklist + pause + self-test
# ---------------------------------------------------------------------------
public_url() {
  if [ -n "$DOMAIN" ]; then echo "https://${DOMAIN}"; return; fi
  local ip; ip="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  echo "http://${ip:-<THIS_VM_IP>}:8080"
}

print_gitlab_checklist() {
  local url secret bot
  url="$(public_url)"
  secret="${GENERATED_SECRET:-<your GITLAB_WEBHOOK_SECRET>}"
  bot="${CLAUDE_BOT_USERNAME:-claude-bot}"

  echo
  echo "${c_bold}════════════════════════ GitLab setup (do this now) ════════════════════════${c_reset}"
  if [ "$PROVISION_MODE" = "service-account" ]; then
    cat <<EOF
 1. ${c_green}Done for you:${c_reset} service account "${bot}" and its api token were created.
    → Add "${bot}" to each target project (or group) as  Developer
       (Members → Invite) so it can be assigned issues and push branches.
EOF
  else
    cat <<EOF
 1. Create/confirm the bot user  "${bot}"  with an api-scoped token, and add it to
    each target project (or group) as  Developer  (can push branches + open MRs).
EOF
  fi
  cat <<EOF

 2. In each project (or the group):  Settings → Webhooks → Add webhook
       URL:           ${url}/webhook
       Secret token:  ${secret}
       Trigger:       [x] Issues events   (leave everything else unchecked)
       SSL verify:    [x] recommended (needs a TLS domain — see --domain)

 3. (Optional) Add a CLAUDE.md to each repo with your coding standards.
${c_bold}═════════════════════════════════════════════════════════════════════════════${c_reset}

EOF
}

pause_for_gitlab() {
  if ! have_tty; then
    warn "Non-interactive run: skipping the ENTER pause. Complete the GitLab steps above."
    return
  fi
  read -r -p "⏸  Complete the GitLab steps above, then press ENTER to run a self-test… " _ < /dev/tty
}

self_test() {
  info "Running connectivity self-test…"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  local code
  code="$(curl -fsS -o /dev/null -w '%{http_code}' \
    --header "PRIVATE-TOKEN: ${GITLAB_BOT_TOKEN}" \
    "${GITLAB_BASE_URL%/}/api/v4/user" || true)"
  if [ "$code" = "200" ]; then
    info "✅ Bot token is valid (GitLab /user returned 200)."
  else
    warn "❌ GitLab /user returned HTTP ${code:-000}. Check GITLAB_BASE_URL / token scope."
  fi
}

print_done() {
  cat <<EOF

${c_green}${c_bold}Done.${c_reset} The ${APP_NAME} is running.

  Webhook URL:   $(public_url)/webhook
  Config:        ${ENV_FILE}
EOF
  if [ "$MODE" = "docker" ]; then
    echo "  Logs:          cd ${APP_DIR} && docker compose logs -f"
    echo "  Restart:       cd ${APP_DIR} && docker compose restart"
  else
    echo "  Logs:          journalctl -u ${APP_NAME} -f"
    echo "  Restart:       systemctl restart ${APP_NAME}"
  fi
  echo
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
uninstall() {
  info "Uninstalling ${APP_NAME}…"
  if [ "$MODE" = "docker" ] && command -v docker >/dev/null 2>&1 && [ -d "$APP_DIR" ]; then
    ( cd "$APP_DIR" && docker compose down 2>/dev/null || true )
  fi
  systemctl disable --now "$APP_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$APP_DIR"
  if [ "$DO_PURGE" -eq 1 ]; then
    rm -f "$ENV_FILE"
    if id "$APP_USER" >/dev/null 2>&1; then userdel -r "$APP_USER" 2>/dev/null || true; fi
    info "Purged config, data, and user."
  else
    info "Left ${ENV_FILE} and user '${APP_USER}' in place (use --purge to remove)."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  need_root

  if [ "$DO_UNINSTALL" -eq 1 ]; then
    uninstall
    exit 0
  fi

  preflight
  install_base_packages
  ensure_user
  fetch_app
  write_env

  if [ "$MODE" = "docker" ]; then
    install_docker
  else
    install_node
    build_app
    install_service
  fi

  setup_caddy
  print_gitlab_checklist
  pause_for_gitlab
  self_test
  print_done
}

main "$@"
