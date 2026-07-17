#!/usr/bin/env bash
#
# tropic — one-command Docker installer for a fresh Ubuntu VM.
#
#   curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/install.sh | sudo bash
#
# Deploys with Docker Compose: the agent container (runs Claude with full privileges
# inside its sandbox) plus a Caddy container that terminates TLS and reverse-proxies to it.
#
# By default the installer CREATES a regular GitLab user for the bot and an api token
# for it, using a one-time admin token you provide (it is never stored). Works on all
# GitLab tiers (Free/CE included).
#
# Flags:
#   --bot-token         Supply a pre-made api-scoped token + username instead of
#                       creating the bot user.
#   --group <id|path>   Add the bot to this group as a Developer member (grants access
#                       to every project in the group). Repeatable.
#   --project <id|path> Add the bot to this project as Developer AND create/update the
#                       Issues webhook. Repeatable.
#   --domain <fqdn>     Serve HTTPS for this domain via the Caddy container (auto cert).
#   --ref <git-ref>     Branch/tag to install (default: main).
#   --uninstall         Stop + remove the containers, KEEP repo/config/data for reinstall.
#   --purge             With --uninstall, also remove repo, config, and Docker volumes.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APP_NAME="tropic"
APP_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
REPO_URL="${REPO_URL:-https://github.com/sharpvik/tropic.git}"
REPO_REF="main"
DOMAIN=""
DO_UNINSTALL=0
DO_PURGE=0
PROVISION_MODE="user"   # user | token
PROJECTS=()
GROUP_TARGETS=()        # NB: not GROUPS — that's a special read-only bash builtin
BOT_USER_ID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
c_reset=$'\e[0m'; c_bold=$'\e[1m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_dim=$'\e[2m'
info()  { echo "${c_green}==>${c_reset} $*"; }
warn()  { echo "${c_yellow}!!${c_reset} $*"; }
err()   { echo "${c_red}xx${c_reset} $*" >&2; }
die()   { err "$*"; exit 1; }
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
      --bot-token) PROVISION_MODE="token" ;;
      --group)   GROUP_TARGETS+=("$2"); shift ;;
      --project) PROJECTS+=("$2"); shift ;;
      --domain)  DOMAIN="$2"; shift ;;
      --ref)     REPO_REF="$2"; shift ;;
      --uninstall) DO_UNINSTALL=1 ;;
      --purge)   DO_PURGE=1 ;;
      *) die "Unknown flag: $1" ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# System prep
# ---------------------------------------------------------------------------
preflight() {
  command -v apt-get >/dev/null 2>&1 || die "This installer targets Debian/Ubuntu (apt)."
  info "Preflight OK (apt-based system detected)."
}

install_base_packages() {
  info "Installing base packages (git, curl, ca-certificates, openssl, jq)…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git curl ca-certificates openssl gnupg jq >/dev/null
}

# Remove anything a previous NATIVE install left on the host — it would fight the
# containers for ports 80/443/8080.
cleanup_legacy() {
  if [ -f "/etc/systemd/system/${APP_NAME}.service" ]; then
    warn "Removing legacy native ${APP_NAME} systemd service…"
    systemctl disable --now "$APP_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/${APP_NAME}.service"
    systemctl daemon-reload 2>/dev/null || true
  fi
  if systemctl is-active caddy >/dev/null 2>&1 || systemctl is-enabled caddy >/dev/null 2>&1; then
    warn "Stopping host Caddy (Caddy now runs as a container)…"
    systemctl disable --now caddy 2>/dev/null || true
  fi
}

install_docker_engine() {
  if command -v docker >/dev/null 2>&1; then
    info "Docker already installed."
    return 0
  fi
  info "Installing Docker Engine…"
  curl -fsSL https://get.docker.com | sh >/dev/null
}

fetch_app() {
  info "Fetching application into ${APP_DIR}…"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  if [ -d "${APP_DIR}/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$REPO_REF"
    git -C "$APP_DIR" checkout -f "$REPO_REF" 2>/dev/null || true
    git -C "$APP_DIR" reset --hard "origin/${REPO_REF}" || true
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  fi
}

# ---------------------------------------------------------------------------
# GitLab API helpers
# ---------------------------------------------------------------------------
# Call the GitLab API, capturing body + status separately so we can report real
# errors. Sets GL_BODY and GL_CODE. Never uses -f (which hides the response).
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

gl_err_msg() {
  echo "$1" | jq -r '(.message // .error // .) | if type=="object" then tojson else tostring end' 2>/dev/null \
    | head -c 300
}

# Prompt for + validate a one-time admin token. Sets ADMIN_TOKEN.
ADMIN_TOKEN=""
require_admin_token() {
  local base="${GITLAB_BASE_URL%/}"
  echo
  guide "How to get an ADMIN token (an account with Administrator access):"
  guide "  1. Open:  ${base}/-/user_settings/personal_access_tokens"
  guide "     (or: top-right avatar → Edit profile → Access tokens)"
  guide "  2. Name it 'bootstrap', set a short expiry (it's one-time)."
  guide "  3. Tick the  ${c_bold}api${c_reset}${c_dim}  scope, click 'Create personal access token'."
  guide "  4. Copy the 'glpat-…' value and paste it below."
  guide "Not an admin? Press Ctrl-C and re-run with  --bot-token."
  prompt_var GITLAB_ADMIN_TOKEN "GitLab ADMIN token (glpat-…, used once, not stored)" "" secret
  ADMIN_TOKEN="$GITLAB_ADMIN_TOKEN"
  [ -n "$ADMIN_TOKEN" ] || die "An admin token is required (or re-run with --bot-token)."

  gl_api GET /user "$ADMIN_TOKEN"
  if [ "$GL_CODE" != "200" ]; then
    err "The admin token was rejected by ${base} (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
    err "Check the token value and that GITLAB_BASE_URL is correct."
    die "Re-run with --bot-token to supply a pre-made token instead."
  fi
}

# Create a regular GitLab user for the bot + an api-scoped token, via the admin API.
# Works on all tiers. Sets GITLAB_BOT_TOKEN, CLAUDE_BOT_USERNAME, BOT_USER_ID.
provision_admin_user() {
  local base="${GITLAB_BASE_URL%/}" sa_name sa_user sa_email uid host
  echo
  info "Provisioning a GitLab bot user (used once; the admin token is not stored)."
  require_admin_token
  if [ "$(echo "$GL_BODY" | jq -r '.is_admin // false')" != "true" ]; then
    err "That token works, but its user is NOT an instance administrator, which is"
    err "required to create users via the API."
    die "Re-run with --bot-token to supply a pre-made token instead."
  fi

  prompt_var SA_NAME     "Display name for the bot" "Claude"
  prompt_var SA_USERNAME "Username for the bot"     "claude-bot"
  host="$(echo "$base" | sed -E 's#^https?://##; s#/.*$##')"
  prompt_var SA_EMAIL    "Email for the bot user"   "${SA_USERNAME}@users.noreply.${host}"
  sa_name="$SA_NAME"; sa_user="$SA_USERNAME"; sa_email="$SA_EMAIL"

  info "Creating bot user '${sa_user}'…"
  gl_api POST /users "$ADMIN_TOKEN" \
    --data-urlencode "email=${sa_email}" \
    --data-urlencode "username=${sa_user}" \
    --data-urlencode "name=${sa_name}" \
    --data-urlencode "force_random_password=true" \
    --data-urlencode "skip_confirmation=true"
  uid="$(echo "$GL_BODY" | jq -r '.id // empty' 2>/dev/null)"
  if [ -z "$uid" ] && echo "$GL_BODY" | grep -qi 'already been taken'; then
    warn "A user with that username/email already exists; reusing it."
    gl_api GET "/users?username=${sa_user}" "$ADMIN_TOKEN"
    uid="$(echo "$GL_BODY" | jq -r '.[0].id // empty' 2>/dev/null)"
  fi
  if [ -z "$uid" ]; then
    err "Could not create the bot user (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
    [ "$GL_CODE" = "403" ] && err "If your instance enforces Admin Mode, admin API via PAT can be blocked."
    die "Re-run with --bot-token to supply a pre-made token instead."
  fi
  CLAUDE_BOT_USERNAME="$sa_user"
  BOT_USER_ID="$uid"
  info "Bot user '${sa_user}' ready (id ${uid})."

  info "Creating an api-scoped token for the bot user…"
  gl_api POST "/users/${uid}/personal_access_tokens" "$ADMIN_TOKEN" \
    --data-urlencode "name=tropic" --data-urlencode "scopes[]=api"
  GITLAB_BOT_TOKEN="$(echo "$GL_BODY" | jq -r '.token // empty' 2>/dev/null)"
  [ -n "$GITLAB_BOT_TOKEN" ] || die "Bot user created but token generation failed (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."
  info "Bot token created."
  # ADMIN_TOKEN is kept in memory for --group/--project wiring; scrubbed in main().
  unset GITLAB_ADMIN_TOKEN
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GENERATED_SECRET=""
write_env() {
  if [ -f "$ENV_FILE" ]; then
    info "Config ${ENV_FILE} already exists; keeping it. (Delete it to reconfigure.)"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    GENERATED_SECRET="${GITLAB_WEBHOOK_SECRET:-}"
    return 0
  fi

  info "Collecting configuration…"
  echo
  guide "Your GitLab instance's base address — the URL you log into, no trailing path."
  guide "  e.g.  https://gitlab.example.com   (or https://gitlab.com for gitlab.com)"
  prompt_var GITLAB_BASE_URL "GitLab base URL"

  if [ "$PROVISION_MODE" = "user" ]; then
    provision_admin_user
  else
    echo
    guide "How to get a bot access token (project or group access token, scope: api):"
    guide "  Project → Settings → Access tokens  (or Group → Settings → Access tokens)"
    guide "  Role: Developer, Scopes: api, then Create. Copy the 'glpat-…' value."
    guide "Creating that token also makes the bot user; use its username below."
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
    info "Generated a webhook secret."
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
JOB_TIMEOUT_MS=14400000
BOT_GIT_USERNAME=${CLAUDE_BOT_USERNAME}
BOT_GIT_EMAIL=${CLAUDE_BOT_USERNAME}@users.noreply.gitlab
EOF
  chmod 600 "$ENV_FILE"
  info "Wrote ${ENV_FILE} (chmod 600)."
}

# Upsert SITE_ADDRESS in the env file (drives the Caddy container). A domain enables
# auto-HTTPS; ":80" serves plain HTTP. Preserves an existing value if --domain is omitted.
set_site_address() {
  local desired
  if [ -n "$DOMAIN" ]; then
    desired="$DOMAIN"
  elif grep -q '^SITE_ADDRESS=' "$ENV_FILE" 2>/dev/null; then
    return 0
  else
    desired=":80"
  fi
  if grep -q '^SITE_ADDRESS=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${desired}|" "$ENV_FILE"
  else
    echo "SITE_ADDRESS=${desired}" >> "$ENV_FILE"
  fi
  info "TLS/site address: ${desired}"
}

# ---------------------------------------------------------------------------
# Deploy (Docker Compose: agent + caddy)
# ---------------------------------------------------------------------------
install_docker() {
  install_docker_engine
  install -m 600 "$ENV_FILE" "${APP_DIR}/${APP_NAME}.env"
  info "Building and starting containers (agent + caddy)…"
  ( cd "$APP_DIR" && docker compose --env-file "$ENV_FILE" up -d --build )
  sleep 3
  if curl -fsS "http://localhost:8080/healthz" >/dev/null 2>&1; then
    info "Agent is up and /healthz responds."
  else
    warn "Started, but /healthz did not respond yet; check: (cd ${APP_DIR} && docker compose logs -f)"
  fi
}

# ---------------------------------------------------------------------------
# GitLab wiring
# ---------------------------------------------------------------------------
public_url() {
  local sa
  sa="$(grep -E '^SITE_ADDRESS=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  if [ -n "$sa" ] && [ "${sa#:}" = "$sa" ]; then
    echo "https://${sa}"
  else
    local ip; ip="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
    echo "http://${ip:-<THIS_VM_IP>}"
  fi
}

# Ensure we have an admin token (prompt if provisioning was skipped) and the bot id.
acquire_admin_and_bot_id() {
  if [ -z "${ADMIN_TOKEN:-}" ]; then
    echo
    info "Wiring GitLab needs an admin token (to add membership + manage webhooks)."
    require_admin_token
  fi
  if [ -z "$BOT_USER_ID" ] && [ -n "${ADMIN_TOKEN:-}" ] && [ -n "${CLAUDE_BOT_USERNAME:-}" ]; then
    gl_api GET "/users?username=${CLAUDE_BOT_USERNAME}" "$ADMIN_TOKEN"
    BOT_USER_ID="$(echo "$GL_BODY" | jq -r '.[0].id // empty' 2>/dev/null)"
  fi
}

# --group: add the bot as a Developer member of each group (access to all its projects).
GROUPS_WIRED=0
setup_group() {
  [ "${#GROUP_TARGETS[@]}" -gt 0 ] || return 0
  acquire_admin_and_bot_id
  echo
  info "Adding the bot to ${#GROUP_TARGETS[@]} group(s) as Developer…"
  local g enc
  for g in "${GROUP_TARGETS[@]}"; do
    enc="${g//\//%2F}"
    if [ -n "${ADMIN_TOKEN:-}" ] && [ -n "$BOT_USER_ID" ]; then
      gl_api POST "/groups/${enc}/members" "$ADMIN_TOKEN" \
        --data-urlencode "user_id=${BOT_USER_ID}" --data-urlencode "access_level=30"
      case "$GL_CODE" in
        201) info "  [${g}] added '${CLAUDE_BOT_USERNAME}' as Developer."; GROUPS_WIRED=$((GROUPS_WIRED+1)) ;;
        409) info "  [${g}] '${CLAUDE_BOT_USERNAME}' is already a member."; GROUPS_WIRED=$((GROUPS_WIRED+1)) ;;
        *)   warn "  [${g}] could not add member (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY")). Add it manually." ;;
      esac
    else
      warn "  [${g}] no admin token — add '${CLAUDE_BOT_USERNAME}' to the group manually."
    fi
  done
  return 0
}

# --project: add the bot as Developer AND create/update the Issues webhook.
PROJECTS_FULLY_WIRED=0
setup_projects() {
  [ "${#PROJECTS[@]}" -gt 0 ] || return 0
  acquire_admin_and_bot_id

  local hook_url token ssl p enc existing member_ok hook_ok
  hook_url="$(public_url)/webhook"
  token="${ADMIN_TOKEN:-$GITLAB_BOT_TOKEN}"
  case "$(public_url)" in https:*) ssl="true" ;; *) ssl="false" ;; esac

  echo
  info "Wiring ${#PROJECTS[@]} project(s): bot membership + Issues webhook…"
  for p in "${PROJECTS[@]}"; do
    enc="${p//\//%2F}"
    member_ok=0; hook_ok=0

    if [ -n "${ADMIN_TOKEN:-}" ] && [ -n "$BOT_USER_ID" ]; then
      gl_api POST "/projects/${enc}/members" "$ADMIN_TOKEN" \
        --data-urlencode "user_id=${BOT_USER_ID}" --data-urlencode "access_level=30"
      case "$GL_CODE" in
        201) info "  [${p}] added '${CLAUDE_BOT_USERNAME}' as Developer."; member_ok=1 ;;
        409) info "  [${p}] '${CLAUDE_BOT_USERNAME}' is already a member."; member_ok=1 ;;
        *)   warn "  [${p}] could not add member (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY")). Add it manually." ;;
      esac
    else
      warn "  [${p}] no admin token — add '${CLAUDE_BOT_USERNAME}' as Developer manually."
    fi

    # Create-or-update the webhook so its secret/settings always match the config.
    gl_api GET "/projects/${enc}/hooks" "$token"
    existing=""
    [ "$GL_CODE" = "200" ] && existing="$(echo "$GL_BODY" | jq -r --arg u "$hook_url" '.[] | select(.url==$u) | .id' 2>/dev/null | head -n1)"
    if [ -n "$existing" ]; then
      gl_api PUT "/projects/${enc}/hooks/${existing}" "$token" \
        --data-urlencode "url=${hook_url}" --data-urlencode "token=${GITLAB_WEBHOOK_SECRET}" \
        --data-urlencode "issues_events=true" --data-urlencode "note_events=true" --data-urlencode "push_events=false" \
        --data-urlencode "enable_ssl_verification=${ssl}"
      if [ "$GL_CODE" = "200" ]; then info "  [${p}] webhook updated (id ${existing}) — secret synced."; hook_ok=1
      else warn "  [${p}] webhook exists (id ${existing}) but update failed (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY"))."; fi
    else
      gl_api POST "/projects/${enc}/hooks" "$token" \
        --data-urlencode "url=${hook_url}" --data-urlencode "token=${GITLAB_WEBHOOK_SECRET}" \
        --data-urlencode "issues_events=true" --data-urlencode "note_events=true" --data-urlencode "push_events=false" \
        --data-urlencode "enable_ssl_verification=${ssl}"
      if [ "$GL_CODE" = "201" ]; then info "  [${p}] Issues webhook created → ${hook_url}"; hook_ok=1
      else warn "  [${p}] could not create webhook (HTTP ${GL_CODE}: $(gl_err_msg "$GL_BODY")). Add it manually."; fi
    fi

    if [ "$member_ok" = 1 ] && [ "$hook_ok" = 1 ]; then
      PROJECTS_FULLY_WIRED=$((PROJECTS_FULLY_WIRED+1))
    fi
  done
  return 0   # never let a not-fully-wired project abort the installer (set -e)
}

# ---------------------------------------------------------------------------
# Checklist + pause + self-test
# ---------------------------------------------------------------------------
print_gitlab_checklist() {
  local url secret bot
  url="$(public_url)"
  secret="${GENERATED_SECRET:-<your GITLAB_WEBHOOK_SECRET>}"
  bot="${CLAUDE_BOT_USERNAME:-claude-bot}"

  echo
  echo "${c_bold}════════════════════════ GitLab setup ════════════════════════${c_reset}"

  if [ "${#PROJECTS[@]}" -gt 0 ] && [ "$PROJECTS_FULLY_WIRED" -eq "${#PROJECTS[@]}" ]; then
    cat <<EOF
 ${c_green}All set — nothing to do.${c_reset}
   • Bot user/token: ready  (${bot})
   • Membership + Issues webhook: created on ${PROJECTS_FULLY_WIRED} project(s)
$( [ "$GROUPS_WIRED" -gt 0 ] && echo "   • Group membership: added to ${GROUPS_WIRED} group(s)" )

 Try it: assign an issue to "${bot}" and watch for a "👋 On it" comment.
${c_bold}══════════════════════════════════════════════════════════════${c_reset}

EOF
    return 0
  fi

  echo " Remaining manual steps:"
  if [ "$PROVISION_MODE" = "user" ]; then
    echo " 1. ${c_green}Done for you:${c_reset} bot \"${bot}\" and its api token were created."
    echo "    → Add \"${bot}\" as Developer to each target project (or group)."
  else
    echo " 1. Create the bot user \"${bot}\" with an api-scoped token; add it as Developer"
    echo "    to each target project (or group)."
  fi
  cat <<EOF

 2. In each project (or group):  Settings → Webhooks → Add webhook
       URL:           ${url}/webhook
       Secret token:  ${secret}
       Trigger:       [x] Issues events   [x] Comments   (leave the rest unchecked)
       SSL verify:    [x] if you used --domain (HTTPS); otherwise off

 3. (Optional) Add a CLAUDE.md to each repo with your coding standards.

 Tip: re-run with  --project <id|group/repo>  (and/or --group <id>) to do this
      automatically.
${c_bold}══════════════════════════════════════════════════════════════${c_reset}

EOF
}

pause_for_gitlab() {
  if ! have_tty; then
    warn "Non-interactive run: skipping the ENTER pause. Complete the GitLab steps above."
    return 0
  fi
  read -r -p "⏸  Complete the GitLab steps above, then press ENTER to run a self-test… " _ < /dev/tty
}

self_test() {
  info "Running self-test…"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  if curl -fsS "http://localhost:8080/healthz" >/dev/null 2>&1; then
    info "✅ Local /healthz OK."
  else
    warn "❌ /healthz not responding — check: (cd ${APP_DIR} && docker compose logs -f)"
  fi
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

${c_green}${c_bold}Done.${c_reset} ${APP_NAME} is running (Docker).

  Webhook URL:  $(public_url)/webhook
  Config:       ${ENV_FILE}
  Logs:         cd ${APP_DIR} && docker compose logs -f
  Restart:      cd ${APP_DIR} && docker compose restart
  Update:       cd ${APP_DIR} && git pull && docker compose --env-file ${ENV_FILE} up -d --build
  Uninstall:    sudo bash ${APP_DIR}/install.sh --uninstall [--purge]

EOF
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
uninstall() {
  info "Stopping ${APP_NAME} containers…"
  if command -v docker >/dev/null 2>&1 && [ -f "${APP_DIR}/docker-compose.yml" ]; then
    ( cd "$APP_DIR" && docker compose down 2>/dev/null || true )
  fi
  # Sweep any legacy native install too.
  systemctl disable --now "$APP_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${APP_NAME}.service"; systemctl daemon-reload 2>/dev/null || true

  if [ "$DO_PURGE" -eq 1 ]; then
    rm -rf "$APP_DIR"
    rm -f "$ENV_FILE"
    if command -v docker >/dev/null 2>&1; then
      docker volume rm \
        ${APP_NAME}_claude-data ${APP_NAME}_claude-workspaces \
        ${APP_NAME}_caddy-data ${APP_NAME}_caddy-config 2>/dev/null || true
    fi
    info "Purged everything: repo (${APP_DIR}), config, and Docker volumes."
  else
    info "Containers stopped and removed."
    info "Kept: ${APP_DIR}, ${ENV_FILE}, and Docker volumes (data)."
    info "Reinstall with:  sudo bash ${APP_DIR}/install.sh"
    info "Full wipe with:  sudo bash ${APP_DIR}/install.sh --uninstall --purge"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  need_root

  if [ "$DO_UNINSTALL" -eq 1 ]; then
    # --purge deletes APP_DIR (which may hold this script). Re-exec from /tmp first.
    if [ "$DO_PURGE" -eq 1 ] && [ "${_GCA_RELOCATED:-}" != "1" ] && [ -f "$0" ]; then
      case "$0" in
        "$APP_DIR"/*)
          _t="$(mktemp /tmp/gca-uninstall-XXXXXX.sh)"; cp "$0" "$_t"
          exec env _GCA_RELOCATED=1 bash "$_t" "$@" ;;
      esac
    fi
    uninstall
    exit 0
  fi

  preflight
  install_base_packages
  cleanup_legacy
  fetch_app
  write_env
  set_site_address
  install_docker
  setup_group
  setup_projects
  unset ADMIN_TOKEN   # scrub the one-time admin token now that provisioning is done

  print_gitlab_checklist
  pause_for_gitlab
  self_test
  print_done
}

main "$@"
