#!/usr/bin/env bash
#
# gitlab-claude-agent — update to the latest version.
#
# Pulls the latest code, rebuilds, redeploys the systemd unit (or Docker image),
# and restarts the service. Safe to run repeatedly.
#
#   sudo bash /opt/gitlab-claude-agent/update.sh
# or, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/sharpvik/tropic/main/update.sh | sudo bash
#
# Env overrides:
#   REPO_REF=<branch|tag>   which ref to update to (default: main)
#
set -euo pipefail

APP_NAME="gitlab-claude-agent"
APP_USER="claude-agent"
APP_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
REPO_REF="${REPO_REF:-main}"

c_reset=$'\e[0m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'
info() { echo "${c_green}==>${c_reset} $*"; }
warn() { echo "${c_yellow}!!${c_reset} $*"; }
err()  { echo "${c_red}xx${c_reset} $*" >&2; }
die()  { err "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (sudo)."

# Re-exec from a temp copy so pulling a new update.sh doesn't rewrite the script
# we're currently executing. (Skipped when piped via curl, where $0 isn't a file.)
if [ "${_UPDATE_RELOCATED:-}" != "1" ] && [ -f "$0" ]; then
  _tmp="$(mktemp /tmp/gca-update-XXXXXX.sh)"
  cp "$0" "$_tmp"
  exec env _UPDATE_RELOCATED=1 bash "$_tmp" "$@"
fi

[ -d "${APP_DIR}/.git" ] || die "No git checkout at ${APP_DIR}. Run install.sh first."

# --- Pull ---
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
old="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo none)"
info "Fetching latest (${REPO_REF})…"
git -C "$APP_DIR" fetch --depth 1 origin "$REPO_REF"
git -C "$APP_DIR" checkout -f "$REPO_REF" 2>/dev/null || true
git -C "$APP_DIR" reset --hard "origin/${REPO_REF}"
new="$(git -C "$APP_DIR" rev-parse --short HEAD)"
if [ "$old" = "$new" ]; then
  info "Already up to date at ${new}."
else
  info "Updated ${old} → ${new}."
fi

# --- Build (native only; Docker builds in the image) ---
is_native() { [ -f "$SERVICE_FILE" ]; }
is_docker() { command -v docker >/dev/null 2>&1 && [ -f "${APP_DIR}/docker-compose.yml" ] \
              && docker compose -f "${APP_DIR}/docker-compose.yml" ps >/dev/null 2>&1; }

if is_native; then
  info "Building…"
  ( cd "$APP_DIR" && npm ci --silent && npm run build --silent && npm prune --omit=dev --silent )
  mkdir -p "${APP_DIR}/workspaces" "${APP_DIR}/data"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

  # Redeploy the unit in case it changed, then restart.
  install -m 0644 "${APP_DIR}/systemd/${APP_NAME}.service" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl restart "$APP_NAME"
  sleep 2
  if ! systemctl is-active --quiet "$APP_NAME"; then
    err "Service is not active after restart. Last log lines:"
    journalctl -u "$APP_NAME" -n 20 --no-pager || true
    die "Aborting."
  fi
  info "Service restarted (active)."
elif is_docker; then
  info "Rebuilding and restarting the container…"
  ( cd "$APP_DIR" && docker compose up -d --build )
  info "Container updated."
else
  die "Could not detect the deployment (no systemd unit at ${SERVICE_FILE}, no running compose stack)."
fi

# --- Health check ---
port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
if curl -fsS "http://localhost:${port:-8080}/healthz" >/dev/null 2>&1; then
  info "Health check OK — now running ${new}."
else
  warn "Service updated but /healthz did not respond yet; check the logs."
fi
info "Done."
