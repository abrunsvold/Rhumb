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

# --- required values enforced ---
if CLAUDE_CODE_OAUTH_TOKEN='' RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "empty token should be rejected"
fi

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

# --- optional block must have no inline comments after assignments (systemd
# EnvironmentFile treats inline # as part of the value) ---
if grep -E '^#?RHUMB_[A-Z_]+=.*[[:space:]]#' "$STAGE/rhumb.env"; then
  fail "inline comment after env assignment (systemd EnvironmentFile footgun)"
fi

echo "PASS install-dry-run"
