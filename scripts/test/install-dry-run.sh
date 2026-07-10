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
