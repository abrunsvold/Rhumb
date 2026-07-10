#!/usr/bin/env bash
# Rhumb guided installer: takes a Linux box from `git clone` to two supervised,
# tailscale-served hosts. Idempotent — re-run after `git pull` to update; your
# configuration in /etc/rhumb/rhumb.env is preserved.
#
# Usage: sudo scripts/install.sh [--yes] [--dry-run [--stage-dir DIR]]
#   --yes        accept all defaults / pre-seeded env values, no prompts
#   --dry-run    write rhumb.env + systemd units to a stage dir; run nothing
#                privileged (no root needed; preflight failures become warnings)
#   --stage-dir  where --dry-run writes its artifacts (default: mktemp -d)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=0
ASSUME_YES=0
STAGE_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --stage-dir)
      STAGE_DIR="${2:?--stage-dir needs a directory}"
      shift
      ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$DRY_RUN" = 1 ]; then
  STAGE_DIR="${STAGE_DIR:-$(mktemp -d)}"
  mkdir -p "$STAGE_DIR"
  ENV_FILE="$STAGE_DIR/rhumb.env"
  UNIT_DIR="$STAGE_DIR"
else
  ENV_FILE=/etc/rhumb/rhumb.env
  UNIT_DIR=/etc/systemd/system
fi

RUN_USER="${SUDO_USER:-$(id -un)}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# fail_or_warn <message with remedy> — hard stop normally, warning in --dry-run
fail_or_warn() {
  if [ "$DRY_RUN" = 1 ]; then warn "$1"; else die "$1"; fi
}

# ---------------------------------------------------------------- preflight
info "Preflight checks"

if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" -ne 0 ]; then
  die "run with sudo: sudo scripts/install.sh (writing /etc/rhumb and systemd units needs root)"
fi

command -v node >/dev/null 2>&1 \
  || fail_or_warn "node not found — install Node.js 20+ (https://nodejs.org, or NodeSource apt repo)"
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed -e 's/^v//' -e 's/\..*//')"
  if [ "${node_major:-0}" -lt 20 ]; then
    fail_or_warn "Node $(node --version) is too old — Rhumb needs >= 20 (https://nodejs.org)"
  fi
fi
command -v npm >/dev/null 2>&1 \
  || fail_or_warn "npm not found — it ships with Node.js 20+; reinstall Node"
command -v tailscale >/dev/null 2>&1 \
  || fail_or_warn "tailscale CLI not found — install from https://tailscale.com/download"
if command -v tailscale >/dev/null 2>&1 && ! tailscale status >/dev/null 2>&1; then
  fail_or_warn "tailscaled is not running or this box is not logged in — run: tailscale up"
fi
command -v systemctl >/dev/null 2>&1 \
  || fail_or_warn "systemd not found — this installer targets systemd Linux; see docs/setup-manual.md for the manual path"
command -v claude >/dev/null 2>&1 \
  || warn "claude CLI not found on this box — fine: run 'claude setup-token' on any machine and paste the token below"

# ---------------------------------------------------------------- detection
TS_LOGIN=""
TS_DNSNAME=""
if command -v tailscale >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 \
  && tailscale status >/dev/null 2>&1; then
  status_json="$(tailscale status --json)"
  TS_DNSNAME="$(printf '%s' "$status_json" | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  TS_LOGIN="$(printf '%s' "$status_json" | python3 -c '
import json, sys
s = json.load(sys.stdin)
users = s.get("User") or {}
uid = str(s.get("Self", {}).get("UserID", ""))
print((users.get(uid) or {}).get("LoginName", ""))
' 2>/dev/null || true)"
fi

# ---- re-run config load ----
MARKER='# --- optional settings (preserved on re-run; edit freely below) ---'
OPTIONAL_SECTION=""
CUR_TOKEN=""
CUR_USERS=""
CUR_WORKSPACE=""
CUR_PORT=""
CUR_DASH_PORT=""
CUR_MODEL=""
CUR_MODE=""

if [ -f "$ENV_FILE" ]; then
  info "Existing config at $ENV_FILE — current values become the defaults"
  env_get() { sed -n "s|^$1=||p" "$ENV_FILE" | tail -n1; }
  CUR_TOKEN="$(env_get CLAUDE_CODE_OAUTH_TOKEN)"
  CUR_USERS="$(env_get RHUMB_ALLOWED_USERS)"
  CUR_WORKSPACE="$(env_get RHUMB_WORKSPACE)"
  CUR_PORT="$(env_get RHUMB_PORT)"
  CUR_DASH_PORT="$(env_get RHUMB_DASHBOARD_PORT)"
  CUR_MODEL="$(env_get RHUMB_MODEL)"
  CUR_MODE="$(env_get RHUMB_PERMISSION_MODE)"
  if grep -qxF "$MARKER" "$ENV_FILE"; then
    OPTIONAL_SECTION="$(awk -v m="$MARKER" 'found; $0 == m { found = 1 }' "$ENV_FILE")"
  else
    cp "$ENV_FILE" "$ENV_FILE.bak"
    warn "no optional-settings marker in existing $ENV_FILE — backed up to $ENV_FILE.bak; re-add any custom lines below the marker"
  fi
fi

# ---------------------------------------------------------------- prompts
# prompt <var-name> <label> <default> [secret]
# --yes or non-tty: takes the default. Otherwise interactive; empty keeps default.
prompt() {
  local __var="$1" __label="$2" __def="$3" __secret="${4:-}" __val=""
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    __val="$__def"
  else
    local __shown="$__def"
    if [ -n "$__secret" ] && [ -n "$__def" ]; then
      __shown="${__def:0:4}… (enter to keep)"
    fi
    if [ -n "$__secret" ]; then
      read -rsp "$__label [$__shown]: " __val && echo
    else
      read -rp "$__label [$__shown]: " __val
    fi
    [ -n "$__val" ] || __val="$__def"
  fi
  printf -v "$__var" '%s' "$__val"
}

info "Configuration (enter accepts the [default])"
prompt CLAUDE_CODE_OAUTH_TOKEN "Claude OAuth token (from 'claude setup-token')" \
  "${CLAUDE_CODE_OAUTH_TOKEN:-$CUR_TOKEN}" secret
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] \
  || die "CLAUDE_CODE_OAUTH_TOKEN is required — run 'claude setup-token' on any machine, then re-run the installer"
prompt RHUMB_ALLOWED_USERS "Tailnet logins allowed to connect (comma-separated)" \
  "${RHUMB_ALLOWED_USERS:-${CUR_USERS:-$TS_LOGIN}}"
[ -n "$RHUMB_ALLOWED_USERS" ] \
  || die "RHUMB_ALLOWED_USERS is required — both hosts refuse to start without an identity allowlist"
prompt RHUMB_WORKSPACE "Workspace directory" \
  "${RHUMB_WORKSPACE:-${CUR_WORKSPACE:-/var/lib/rhumb/workspace}}"
prompt RHUMB_PORT "Agent host port" "${RHUMB_PORT:-${CUR_PORT:-8787}}"
prompt RHUMB_DASHBOARD_PORT "Dashboard host port" \
  "${RHUMB_DASHBOARD_PORT:-${CUR_DASH_PORT:-8788}}"
prompt RHUMB_MODEL "Claude model" "${RHUMB_MODEL:-${CUR_MODEL:-claude-opus-4-8}}"
prompt RHUMB_PERMISSION_MODE "Permission mode (default|acceptEdits|bypassPermissions|plan)" \
  "${RHUMB_PERMISSION_MODE:-${CUR_MODE:-acceptEdits}}"

# ---------------------------------------------------------------- env file
info "Writing $ENV_FILE"
if [ "$DRY_RUN" = 0 ]; then
  mkdir -p /etc/rhumb
fi
env_tmp="$(mktemp)"
{
  cat <<EOF
# Rhumb configuration — read by both hosts via systemd EnvironmentFile.
# Re-running scripts/install.sh preserves these values (they become the prompt
# defaults) and keeps everything below the optional-settings marker verbatim.
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
RHUMB_ALLOWED_USERS=$RHUMB_ALLOWED_USERS
RHUMB_WORKSPACE=$RHUMB_WORKSPACE
RHUMB_PORT=$RHUMB_PORT
RHUMB_DASHBOARD_PORT=$RHUMB_DASHBOARD_PORT
RHUMB_MODEL=$RHUMB_MODEL
RHUMB_PERMISSION_MODE=$RHUMB_PERMISSION_MODE
$MARKER
EOF
  if [ -n "$OPTIONAL_SECTION" ]; then
    printf '%s\n' "$OPTIONAL_SECTION"
  else
    cat <<'EOF'
# Uncomment and set as needed. Relative artifacts default to files under
# RHUMB_WORKSPACE. Full semantics: agent-host/README.md, dashboard-host/README.md.

# Postgres superuser connection string — enables agent database provisioning
# (and installs the per-database DDL audit on provision).
#RHUMB_PG_ADMIN=postgres://postgres:secret@127.0.0.1:5432/postgres

# Registry/audit file overrides (defaults live under the workspace).
#RHUMB_DATA_SOURCES=   # data-sources.json — registered data sources
#RHUMB_DATA_TRUST=     # data-trust.json — per-surface write-back trust grants
#RHUMB_DATA_AUDIT=     # data-audit.jsonl — data write audit trail
#RHUMB_INFRA_AUDIT=    # infra-audit.jsonl — infra action audit trail
#RHUMB_SERVICES=       # services.json — spawned-service registry

# Ontology vault directory (default <workspace>/ontology).
#RHUMB_ONTOLOGY=

# Extra origins allowed to call the /data endpoint (spawned apps), comma-separated.
#RHUMB_APP_ORIGINS=

# Spawned-service LXC settings (only on a Proxmox host).
#RHUMB_LXC_TEMPLATE=local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst
#RHUMB_LXC_STORAGE=local-lvm
#RHUMB_LXC_BRIDGE=vmbr0
#RHUMB_LXC_NAMESERVER=1.1.1.1
#RHUMB_LXC_ROOTFS_GB=8

# SSH deploy key for spawned services (private key path; public key defaults
# to <RHUMB_DEPLOY_KEY>.pub, or set contents explicitly).
#RHUMB_DEPLOY_KEY=
#RHUMB_DEPLOY_PUBKEY=

# Post-deploy health gate deadline in milliseconds (default 90000).
#RHUMB_HEALTH_GATE_MS=
EOF
  fi
} >"$env_tmp"
install -m 600 "$env_tmp" "$ENV_FILE"
rm -f "$env_tmp"

# ---------------------------------------------------------------- systemd units
NODE_BIN="$(command -v node || echo /usr/bin/node)"

# render_unit <template> <dest> — fill @RUN_USER@/@REPO_DIR@/@NODE_BIN@
render_unit() {
  sed -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@REPO_DIR@|$REPO_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    "$1" >"$2"
}

info "Rendering systemd units into $UNIT_DIR"
render_unit "$REPO_DIR/scripts/systemd/rhumb-agent.service.tmpl" "$UNIT_DIR/rhumb-agent.service"
render_unit "$REPO_DIR/scripts/systemd/rhumb-dashboard.service.tmpl" "$UNIT_DIR/rhumb-dashboard.service"

# ---- privileged install ----

if [ "$DRY_RUN" = 1 ]; then
  info "Dry run complete — staged artifacts in $STAGE_DIR"
fi
