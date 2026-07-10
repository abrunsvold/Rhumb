# Guided Install Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One interactive, idempotent `scripts/install.sh` that takes a Linux box from `git clone` to two systemd-supervised, tailscale-served Rhumb hosts, plus a 3-command README quickstart with the manual path moved to `docs/setup-manual.md`.

**Architecture:** A single bash installer with a non-privileged `--dry-run --stage-dir` mode (writes the env file and rendered systemd units to a stage directory, executes nothing privileged) so the prompt/detect/write logic is smoke-testable on any machine. The real run additionally builds both packages, invokes the existing `scripts/setup-serve.sh`, and installs/enables two systemd units that share one `EnvironmentFile=/etc/rhumb/rhumb.env`. Re-running preserves config (existing values become prompt defaults; everything below an optional-settings marker line is kept verbatim) — so re-run is the update path after `git pull`.

**Tech Stack:** bash (`set -euo pipefail`, shellcheck-clean), systemd, tailscale CLI, existing `scripts/setup-serve.sh` (unchanged), Node 20+ / npm for builds.

**Spec:** `docs/superpowers/specs/2026-07-09-install-bootstrap-design.md`

## Global Constraints

- Node floor is **>= 20** (both packages' `engines`).
- Core env vars and exact defaults: `RHUMB_PORT=8787`, `RHUMB_DASHBOARD_PORT=8788`, `RHUMB_MODEL=claude-opus-4-8`, `RHUMB_PERMISSION_MODE=acceptEdits`, workspace default for installed deployments `/var/lib/rhumb/workspace`.
- Config file: `/etc/rhumb/rhumb.env`, mode **600**, root-owned. Units run as the **invoking (non-root) user** (`SUDO_USER`), never root.
- `scripts/setup-serve.sh` is **reused by invocation, not duplicated or modified**.
- The installer must be **idempotent**: safe to re-run after partial failure and after `git pull`.
- Every preflight failure prints a one-line remedy. In `--dry-run`, preflight failures downgrade to warnings so the flow is testable anywhere.
- shellcheck-clean (`shellcheck scripts/install.sh scripts/test/install-dry-run.sh`).
- Client packaging, Postgres installation, Docker/LXC images: **out of scope**.
- Repo URL for docs: `https://github.com/abrunsvold/Rhumb`.
- Commit after every task; commit messages follow the repo's `feat(scope):`/`docs:` convention and end with the Claude co-author trailer.

---

### Task 1: Installer core — flags, preflight, detection, prompts, env-file write (dry-run testable)

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/test/install-dry-run.sh`

**Interfaces:**
- Consumes: `tailscale status --json` (same parse as `scripts/setup-serve.sh`), env-var pre-seeding (`CLAUDE_CODE_OAUTH_TOKEN`, `RHUMB_ALLOWED_USERS`, `RHUMB_PORT`, …).
- Produces: `install.sh --dry-run --yes --stage-dir DIR` writes `DIR/rhumb.env`. Variables/functions later tasks rely on: `DRY_RUN`, `ASSUME_YES`, `STAGE_DIR`, `ENV_FILE`, `UNIT_DIR`, `REPO_DIR`, `RUN_USER`, `NODE_BIN`, `TS_LOGIN`, `TS_DNSNAME`, `MARKER`, `OPTIONAL_SECTION`, the seven core `RHUMB_*`/token variables, and helpers `info`/`warn`/`die`/`prompt`. Anchor comments `# ---- re-run config load ----`, `# ---- privileged install ----` mark where Tasks 3 and 4 insert code.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/test/install-dry-run.sh`:

```bash
#!/usr/bin/env bash
# Smoke test for scripts/install.sh --dry-run. No root, no tailscale needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- fresh install (dry-run, all defaults, seeded secrets) ---
CLAUDE_CODE_OAUTH_TOKEN=tok-test-123 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE" >/dev/null

grep -q '^CLAUDE_CODE_OAUTH_TOKEN=tok-test-123$' "$STAGE/rhumb.env" || fail "token not written"
grep -q '^RHUMB_ALLOWED_USERS=alice@github$'     "$STAGE/rhumb.env" || fail "allowlist not written"
grep -q '^RHUMB_WORKSPACE=/var/lib/rhumb/workspace$' "$STAGE/rhumb.env" || fail "workspace default missing"
grep -q '^RHUMB_PORT=8787$'            "$STAGE/rhumb.env" || fail "agent port default missing"
grep -q '^RHUMB_DASHBOARD_PORT=8788$'  "$STAGE/rhumb.env" || fail "dashboard port default missing"
grep -q '^RHUMB_MODEL=claude-opus-4-8$' "$STAGE/rhumb.env" || fail "model default missing"
grep -q '^RHUMB_PERMISSION_MODE=acceptEdits$' "$STAGE/rhumb.env" || fail "permission mode default missing"
grep -q '^#RHUMB_PG_ADMIN='  "$STAGE/rhumb.env" || fail "optional settings block missing"
grep -qF -- '# --- optional settings (preserved on re-run; edit freely below) ---' "$STAGE/rhumb.env" \
  || fail "optional-settings marker missing"

# --- required values enforced ---
if CLAUDE_CODE_OAUTH_TOKEN= RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "empty token should be rejected"
fi

echo "PASS install-dry-run"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/test/install-dry-run.sh`
Expected: FAIL — `scripts/install.sh: No such file or directory`

- [ ] **Step 3: Write the installer core**

Create `scripts/install.sh`:

```bash
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

# ---- privileged install ----

if [ "$DRY_RUN" = 1 ]; then
  info "Dry run complete — staged artifacts in $STAGE_DIR"
fi
```

Then: `chmod +x scripts/install.sh scripts/test/install-dry-run.sh`

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/test/install-dry-run.sh`
Expected: `PASS install-dry-run`

- [ ] **Step 5: shellcheck both files**

Run: `shellcheck scripts/install.sh scripts/test/install-dry-run.sh` (if shellcheck isn't installed: `brew install shellcheck` on macOS / `apt install shellcheck` on Debian; if it can't be installed in this environment, run `bash -n` on both files and note in the commit message that shellcheck ran clean locally is deferred to Task 4)
Expected: no output (clean)

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh scripts/test/install-dry-run.sh
git commit -m "feat(install): guided installer core — preflight, detection, prompts, rhumb.env

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: systemd unit templates + rendering

**Files:**
- Create: `scripts/systemd/rhumb-agent.service.tmpl`
- Create: `scripts/systemd/rhumb-dashboard.service.tmpl`
- Modify: `scripts/install.sh` (insert rendering above the `# ---- privileged install ----` anchor)
- Modify: `scripts/test/install-dry-run.sh` (append assertions before the final `echo "PASS…"`)

**Interfaces:**
- Consumes: `REPO_DIR`, `RUN_USER`, `UNIT_DIR`, `DRY_RUN`, `info` from Task 1. Templates use `@RUN_USER@`, `@REPO_DIR@`, `@NODE_BIN@` placeholder tokens.
- Produces: rendered `rhumb-agent.service` / `rhumb-dashboard.service` in `$UNIT_DIR`; `render_unit <template> <dest>` function; `NODE_BIN` variable. Task 4 runs `systemctl daemon-reload && systemctl enable --now` on these unit names.

- [ ] **Step 1: Extend the smoke test (failing)**

In `scripts/test/install-dry-run.sh`, insert before the required-values block:

```bash
# --- systemd units rendered into the stage dir ---
test -f "$STAGE/rhumb-agent.service"     || fail "agent unit not staged"
test -f "$STAGE/rhumb-dashboard.service" || fail "dashboard unit not staged"
grep -q '^EnvironmentFile=/etc/rhumb/rhumb.env$' "$STAGE/rhumb-agent.service" || fail "agent unit EnvironmentFile"
grep -q '^EnvironmentFile=/etc/rhumb/rhumb.env$' "$STAGE/rhumb-dashboard.service" || fail "dashboard unit EnvironmentFile"
grep -q "^User=$(id -un)\$" "$STAGE/rhumb-agent.service" || fail "agent unit User not invoking user"
grep -q '/agent-host$'     "$STAGE/rhumb-agent.service"     || fail "agent unit WorkingDirectory"
grep -q '/dashboard-host$' "$STAGE/rhumb-dashboard.service" || fail "dashboard unit WorkingDirectory"
grep -Eq '^ExecStart=.+/node dist/index\.js$' "$STAGE/rhumb-agent.service" || fail "agent unit ExecStart"
grep -q '@' "$STAGE/rhumb-agent.service" && fail "unrendered @token@ left in agent unit"
```

Note: the last line uses `&& fail` (grep finding `@` is the failure). `RHUMB_ALLOWED_USERS=alice@github` lives in rhumb.env, not the unit, so the units must contain no `@` at all.

Run: `bash scripts/test/install-dry-run.sh`
Expected: FAIL — `agent unit not staged`

- [ ] **Step 2: Create the unit templates**

`scripts/systemd/rhumb-agent.service.tmpl`:

```ini
[Unit]
Description=Rhumb agent host (Claude Code session API)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=@RUN_USER@
WorkingDirectory=@REPO_DIR@/agent-host
EnvironmentFile=/etc/rhumb/rhumb.env
ExecStart=@NODE_BIN@ dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`scripts/systemd/rhumb-dashboard.service.tmpl`:

```ini
[Unit]
Description=Rhumb dashboard host (surfaces, registry, data endpoint)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=@RUN_USER@
WorkingDirectory=@REPO_DIR@/dashboard-host
EnvironmentFile=/etc/rhumb/rhumb.env
ExecStart=@NODE_BIN@ dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Add rendering to install.sh**

Insert directly above the `# ---- privileged install ----` anchor:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/test/install-dry-run.sh`
Expected: `PASS install-dry-run`

- [ ] **Step 5: Commit**

```bash
git add scripts/systemd scripts/install.sh scripts/test/install-dry-run.sh
git commit -m "feat(install): systemd unit templates + rendering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Idempotent re-run — existing config becomes defaults, optional section preserved

**Files:**
- Modify: `scripts/install.sh` (fill in the `# ---- re-run config load ----` anchor)
- Modify: `scripts/test/install-dry-run.sh` (append re-run assertions before the final `echo "PASS…"`)

**Interfaces:**
- Consumes: `ENV_FILE`, `MARKER`, `CUR_*` variables (declared empty in Task 1), `info`/`warn`.
- Produces: on re-run, `CUR_*` hold the existing file's values (used as prompt defaults by the Task 1 prompt chain), and `OPTIONAL_SECTION` holds everything below the marker verbatim (re-emitted by the Task 1 env-file writer).

- [ ] **Step 1: Extend the smoke test (failing)**

Append before the final `echo "PASS install-dry-run"`:

```bash
# --- re-run preserves config: core values become defaults, optional section kept ---
sed -e 's|^#RHUMB_LXC_BRIDGE=.*|RHUMB_LXC_BRIDGE=vmbr1|' \
    -e 's|^RHUMB_PORT=8787$|RHUMB_PORT=9999|' \
    "$STAGE/rhumb.env" >"$STAGE/rhumb.env.edited"
mv "$STAGE/rhumb.env.edited" "$STAGE/rhumb.env"

scripts/install.sh --dry-run --yes --stage-dir "$STAGE" >/dev/null

grep -q '^CLAUDE_CODE_OAUTH_TOKEN=tok-test-123$' "$STAGE/rhumb.env" || fail "token not preserved on re-run"
grep -q '^RHUMB_ALLOWED_USERS=alice@github$' "$STAGE/rhumb.env" || fail "allowlist not preserved on re-run"
grep -q '^RHUMB_PORT=9999$' "$STAGE/rhumb.env" || fail "edited core value not used as re-run default"
grep -q '^RHUMB_LXC_BRIDGE=vmbr1$' "$STAGE/rhumb.env" || fail "uncommented optional var not preserved"
grep -q '^#RHUMB_LXC_STORAGE=' "$STAGE/rhumb.env" || fail "rest of optional block not preserved"

# --- markerless (hand-written) file: backed up, values still used ---
printf 'RHUMB_PORT=7777\nCLAUDE_CODE_OAUTH_TOKEN=tok-hand\nRHUMB_ALLOWED_USERS=carol@github\n' >"$STAGE/rhumb.env"
scripts/install.sh --dry-run --yes --stage-dir "$STAGE" >/dev/null 2>&1
test -f "$STAGE/rhumb.env.bak" || fail "markerless config not backed up"
grep -q '^RHUMB_PORT=7777$' "$STAGE/rhumb.env" || fail "markerless core value not carried over"
```

Note the second run passes **no** seeding env vars — everything must come from the existing file. (`CLAUDE_CODE_OAUTH_TOKEN` and `RHUMB_ALLOWED_USERS` are exported for the first run only via the `VAR=… command` form, so they are not in the test shell's environment afterwards.)

Run: `bash scripts/test/install-dry-run.sh`
Expected: FAIL — `edited core value not used as re-run default` (a fresh default file overwrites the edits)

- [ ] **Step 2: Implement the re-run load**

Replace the block between `# ---- re-run config load ----` and the prompt section (keep the `MARKER=` line and the empty `CUR_*`/`OPTIONAL_SECTION` declarations, then add):

```bash
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
```

Subtlety: `env_get RHUMB_PORT` must not also match `RHUMB_PORT` inside other names — it can't, since the pattern is anchored (`^RHUMB_PORT=`) and no other var name starts with `RHUMB_PORT` except itself (`RHUMB_PORTX` doesn't exist). Same for the others.

- [ ] **Step 3: Run test to verify it passes**

Run: `bash scripts/test/install-dry-run.sh`
Expected: `PASS install-dry-run`

- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh scripts/test/install-dry-run.sh
git commit -m "feat(install): idempotent re-run — existing config seeds defaults, optional section preserved

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Privileged path — workspace, builds, tailscale serve, unit enablement, verify & report

**Files:**
- Modify: `scripts/install.sh` (fill in below the `# ---- privileged install ----` anchor; the dry-run early summary stays last)

**Interfaces:**
- Consumes: everything from Tasks 1–3; `scripts/setup-serve.sh` (invoked, honors `RHUMB_PORT`/`RHUMB_DASHBOARD_PORT` env).
- Produces: running `rhumb-agent.service` + `rhumb-dashboard.service`, final summary output. No later task consumes code from this one.

This section is not exercisable by the dry-run smoke test — verification is shellcheck + `bash -n` + review here, and a live box run at the end of the branch (see Task 6 step 4).

- [ ] **Step 1: Implement the privileged section**

Replace the `# ---- privileged install ----` region (keeping the trailing dry-run summary as the alternative branch) with:

```bash
# ---- privileged install ----
if [ "$DRY_RUN" = 1 ]; then
  info "Dry run complete — staged artifacts in $STAGE_DIR"
  exit 0
fi

# workspace (shared by both hosts; owned by the service user)
info "Ensuring workspace at $RHUMB_WORKSPACE"
mkdir -p "$RHUMB_WORKSPACE"
chown "$RUN_USER" "$RHUMB_WORKSPACE"

# builds — as the invoking user (direct root logins, e.g. Proxmox LXC consoles
# without sudo installed, have RUN_USER=root and take the first branch)
build_pkg() {
  info "Building $1"
  if [ "$(id -un)" = "$RUN_USER" ]; then
    bash -c "cd '$REPO_DIR/$1' && npm ci && npm run build" \
      || die "build failed in $1 — fix the error above and re-run the installer"
  else
    sudo -u "$RUN_USER" -H bash -c "cd '$REPO_DIR/$1' && npm ci && npm run build" \
      || die "build failed in $1 — fix the error above and re-run the installer"
  fi
}
build_pkg agent-host
build_pkg dashboard-host

# tailscale serve — reuse the standalone script (idempotent mounts)
info "Mounting hosts behind tailscale serve"
RHUMB_PORT="$RHUMB_PORT" RHUMB_DASHBOARD_PORT="$RHUMB_DASHBOARD_PORT" \
  "$REPO_DIR/scripts/setup-serve.sh"

# enable + start units
info "Enabling systemd units"
systemctl daemon-reload
systemctl enable --now rhumb-agent.service rhumb-dashboard.service
systemctl restart rhumb-agent.service rhumb-dashboard.service

# verify
sleep 2
install_ok=1
for unit in rhumb-agent rhumb-dashboard; do
  if systemctl is-active --quiet "$unit"; then
    info "$unit: active"
  else
    install_ok=0
    warn "$unit is not running — inspect: journalctl -u $unit -n 50"
  fi
done
for port in "$RHUMB_PORT" "$RHUMB_DASHBOARD_PORT"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" || true)"
  if [ "$code" = "000" ]; then
    install_ok=0
    warn "nothing answering on 127.0.0.1:$port"
  fi
done

echo
info "Rhumb is installed"
if [ -n "$TS_DNSNAME" ]; then
  echo "  URL:        https://$TS_DNSNAME   (dashboard at /, agent at /agent)"
fi
echo "  Allowlist:  $RHUMB_ALLOWED_USERS"
echo "  Config:     $ENV_FILE"
echo "  Workspace:  $RHUMB_WORKSPACE"
echo "  Logs:       journalctl -u rhumb-agent -f   |   journalctl -u rhumb-dashboard -f"
echo "  Update:     git pull && sudo scripts/install.sh   (your config is preserved)"
if [ "$install_ok" = 0 ]; then
  die "install finished with failures — see warnings above, fix, and re-run (safe to repeat)"
fi
```

Notes for the implementer:
- `systemctl restart` after `enable --now` makes re-runs pick up new builds and config (`enable --now` alone is a no-op when the unit is already running). Identity-mode hosts answer loopback curl with 4xx — any HTTP code except `000` (connection failure) counts as "up".
- The identity-mode hosts bind loopback only; `tailscale serve` is the tailnet front door, matching the units' loopback ExecStart.

- [ ] **Step 2: Static checks**

Run: `bash -n scripts/install.sh && bash scripts/test/install-dry-run.sh && shellcheck scripts/install.sh scripts/test/install-dry-run.sh`
Expected: `PASS install-dry-run`, shellcheck clean (address any findings; `SC1091` for sourced-file warnings may be directive-suppressed with a comment if it appears)

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): privileged path — builds, tailscale serve, systemd enablement, verify

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: docs/setup-manual.md — the manual path, local dev, troubleshooting

**Files:**
- Create: `docs/setup-manual.md`

**Interfaces:**
- Consumes: current README Quickstart content (steps 1–5 + "Local development without a tailnet") — this task moves it, lightly edited; Task 6 deletes it from README and links here.
- Produces: `docs/setup-manual.md` with anchors `#manual-setup`, `#local-development-without-a-tailnet`, `#troubleshooting` (auto-generated from the headings below).

- [ ] **Step 1: Write the document**

Create `docs/setup-manual.md` with exactly this content:

````markdown
# Manual setup

The [README quickstart](../README.md#quickstart) (`sudo scripts/install.sh`) is the
recommended path on a Linux box. This page is for everything else: macOS, boxes
without systemd, understanding what the installer does, and local development
without a tailnet.

You'll need [Node.js](https://nodejs.org) 20+, a Claude subscription, and (for
the intended setup) a Tailscale tailnet.

## Manual setup

### 1. Get a Claude token

```sh
claude setup-token        # produces a long-lived CLAUDE_CODE_OAUTH_TOKEN
```

### 2. Put both hosts behind `tailscale serve`

On the box, run the setup script once. It mounts both hosts behind a single
tailnet HTTPS origin and prints the tailnet login(s) to allowlist:

```sh
scripts/setup-serve.sh
```

> **First run:** if `tailscale serve` has never been used on your tailnet, the
> script pauses and prints a `login.tailscale.com` link — a tailnet admin must
> click it once to enable Serve (and HTTPS certificates, if prompted) before
> setup can continue.

### 3. Set the allowlist and run the agent host

`RHUMB_ALLOWED_USERS` is a comma-separated list of tailnet logins (e.g.
`alice@github`) permitted to reach the hosts. Set it on **both** hosts — they
refuse to start without it:

```sh
cd agent-host
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start
```

Defaults: port `8787`, model `claude-opus-4-8`, workspace `./workspace`,
permission mode `acceptEdits`. The host binds loopback only — `tailscale serve`
is what makes it reachable from the tailnet. See
[`agent-host/README.md`](../agent-host/README.md) for all environment variables
and the security model behind permission modes.

### 4. Run the dashboard host

Point it at the **same workspace** as the agent host, with the same allowlist:

```sh
cd dashboard-host
npm install
npm run build
RHUMB_WORKSPACE=../agent-host/workspace RHUMB_ALLOWED_USERS=you@github npm start
```

Defaults: port `8788`, loopback bind. See
[`dashboard-host/README.md`](../dashboard-host/README.md).

### 5. Keep them running

Nothing above survives a reboot. On systemd Linux, `sudo scripts/install.sh`
sets up `rhumb-agent.service` and `rhumb-dashboard.service` for you (it is safe
to run after a manual setup — your env values can be re-entered at the prompts,
and from then on configuration lives in `/etc/rhumb/rhumb.env`). On other
platforms, use your process supervisor of choice pointed at `npm start` in each
package with the environment variables above.

## Local development without a tailnet

Set `RHUMB_INSECURE_DEV=1` on both hosts to skip identity checks and the
loopback-only bind entirely — useful for running everything on one machine
without Tailscale. **Never set this on a box reachable by anyone else**: it
disables the Tailscale identity allowlist and all of the request
authentication described in [`SECURITY.md`](../SECURITY.md).

Note that the desktop client can't connect to bare two-port `RHUMB_INSECURE_DEV`
hosts as-is: it speaks to a single HTTPS origin (`/` for the dashboard host,
`/agent` for the agent host), which normally comes from `tailscale serve`. For
local development without a tailnet, either run `tailscale serve` locally or
put a reverse proxy in front that maps `/` → `:8788` and `/agent` → `:8787`.
`RHUMB_INSECURE_DEV` hosts on their own (without that single-origin front end)
are meant to be exercised directly via `curl`/`supertest`, not the desktop client.

## Troubleshooting

- **`tailscale serve` prints a `login.tailscale.com` link and waits** — Serve
  isn't enabled on your tailnet yet. A tailnet admin must click the link once;
  then re-run.
- **HTTPS certificate errors on first request** — enable MagicDNS + HTTPS
  certificates for your tailnet: <https://login.tailscale.com/admin/dns>.
- **A host exits immediately with `RHUMB_ALLOWED_USERS is required`** — both
  hosts fail closed without an identity allowlist. Set it (comma-separated
  tailnet logins, e.g. `alice@github`), or `RHUMB_INSECURE_DEV=1` for local
  dev only.
- **Installer says a unit is not running** — read the log it points at:
  `journalctl -u rhumb-agent -n 50` (or `rhumb-dashboard`). Fix the cause
  (most often a bad token or a port collision) and re-run
  `sudo scripts/install.sh` — it's idempotent.
- **The desktop client's discovery finds nothing** — discovery needs the
  `tailscale` CLI on your laptop. Without it, enter the box's HTTPS origin
  (`https://<box>.<tailnet>.ts.net`) manually in the picker.
- **Changed a value in `/etc/rhumb/rhumb.env`** — apply it with
  `sudo systemctl restart rhumb-agent rhumb-dashboard` (or re-run the
  installer).
````

- [ ] **Step 2: Verify links resolve**

Run: `ls agent-host/README.md dashboard-host/README.md SECURITY.md README.md`
Expected: all four exist (the doc's relative links are `../` from `docs/`).

- [ ] **Step 3: Commit**

```bash
git add docs/setup-manual.md
git commit -m "docs: manual setup guide with local-dev and troubleshooting sections

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: README quickstart rewrite

**Files:**
- Modify: `README.md` (the `## Quickstart` section, everything from `## Quickstart` up to but excluding `## Security model — read before exposing anything`)

**Interfaces:**
- Consumes: `docs/setup-manual.md` (Task 5), `scripts/install.sh` behavior (Tasks 1–4).
- Produces: the final user-facing on-ramp. Nothing downstream.

- [ ] **Step 1: Replace the Quickstart section**

Replace the entire current `## Quickstart` section (including its `### 1.`–`### 5.` steps and the `### Local development without a tailnet` subsection — all of it now lives in `docs/setup-manual.md`) with:

````markdown
## Quickstart

**Prerequisites:** a Linux box with systemd on your [Tailscale](https://tailscale.com) tailnet, [Node.js](https://nodejs.org) 20+, and a Claude subscription. The intended home is a Proxmox host or container, but any Linux box gives you the core experience.

```sh
git clone https://github.com/abrunsvold/Rhumb && cd Rhumb
claude setup-token      # on any machine — you'll paste the token into the installer
sudo scripts/install.sh
```

The installer checks prerequisites (telling you exactly what to fix if one is missing), auto-detects your tailnet login for the access allowlist, prompts for the Claude token, builds both hosts, mounts them behind `tailscale serve`, and installs systemd units (`rhumb-agent`, `rhumb-dashboard`) so everything starts on boot and restarts on crash. When it finishes it prints your Rhumb URL.

All configuration lives in one file, `/etc/rhumb/rhumb.env`, with the optional settings (Postgres provisioning, spawned-service LXC knobs, ontology paths) documented inline as commented-out lines. The installer is idempotent: after `git pull`, re-run it to rebuild and restart — your configuration is preserved.

> **First run:** if `tailscale serve` has never been used on your tailnet, the installer pauses and prints a `login.tailscale.com` link — a tailnet admin must click it once to enable Serve (and HTTPS certificates, if prompted) before setup can continue.

Running on macOS, without systemd, or want to see every step? **[docs/setup-manual.md](docs/setup-manual.md)** has the step-by-step path, plus local development without a tailnet and a troubleshooting guide.

### Connect the client

The [`client/`](client/) is a Tauri v2 desktop app. Build and run it with the Tauri CLI:

```sh
cd client
npm install
npm run tauri dev       # or `npm run tauri build` for an installable app bundle
```

On first launch it discovers boxes running `tailscale serve` with Rhumb's `/.well-known/rhumb.json` manifest and lists them in a picker — click one to connect. If discovery finds nothing (e.g. the `tailscale` CLI isn't available on your laptop), enter the box's HTTPS origin manually instead.
````

Keep everything before `## Quickstart` and from `## Security model — read before exposing anything` onward untouched.

- [ ] **Step 2: Check internal consistency**

Run: `grep -n 'setup-manual\|install.sh\|RHUMB_INSECURE_DEV' README.md`
Expected: `setup-manual.md` and `install.sh` referenced in the new Quickstart; **no** remaining `RHUMB_INSECURE_DEV` mention in README (it moved to the manual doc). Also run `grep -n 'Local development without a tailnet' README.md` — expected: no matches.

Also update the Goals section's "Smooth the on-ramp" bullet to reflect reality. Replace:

```markdown
- **Harden for less-trusted networks.** Rhumb currently assumes a private tailnet. Tighten the agent-host permission model and workspace path handling so a mistake costs less — the hosts now authenticate against a Tailscale identity allowlist, but the model still assumes a single trusted operator.
- **Smooth the on-ramp.** Setup is still homelab-grade. Better first-run docs, clearer defaults, and fewer manual steps between `clone` and a running tool.
```

with:

```markdown
- **Harden for less-trusted networks.** Rhumb currently assumes a private tailnet. Tighten the agent-host permission model and workspace path handling so a mistake costs less — the hosts now authenticate against a Tailscale identity allowlist, but the model still assumes a single trusted operator.
- **Smooth the on-ramp.** `scripts/install.sh` now takes a box from clone to supervised, tailnet-served hosts in one guided run. Next: prebuilt desktop-client releases so connecting doesn't require a Rust toolchain.
```

- [ ] **Step 3: Full check**

Run: `bash scripts/test/install-dry-run.sh && shellcheck scripts/install.sh scripts/test/install-dry-run.sh`
Expected: `PASS install-dry-run`, shellcheck clean.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: 3-command quickstart via guided installer; manual path moved to docs/setup-manual.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-merge verification (not a task for the executor)

Live-box dogfood, per the spec's testing section: on the box, `git pull`, run `sudo scripts/install.sh` for real, reboot, confirm both units come back (`systemctl status rhumb-agent rhumb-dashboard`) and the packaged client connects. Record findings in `docs/dogfood/` as usual.
