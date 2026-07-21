#!/usr/bin/env bash
# Smoke test for scripts/install.sh --dry-run. No root, no tailscale needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Hermetic run: the installer intentionally honors already-exported credential
# vars as pre-seeded values (that's what --yes is for), so an ambient
# ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/RHUMB_LLM_PROVIDER
# (e.g. from running this inside a Claude session) would silently leak into
# every assertion below. Start from a clean slate for these.
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN RHUMB_LLM_PROVIDER 2>/dev/null || true

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- fresh install (dry-run, all defaults, seeded secrets) ---
# Nothing is persisted yet, so no override warning should fire no matter
# what — assert stderr is clean, not just that the run succeeds.
fresh_err="$(CLAUDE_CODE_OAUTH_TOKEN=tok-test-123 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE" 2>&1 >/dev/null)"
printf '%s\n' "$fresh_err" | grep -qE 'overriding the saved one|is set in the environment' \
  && fail "fresh install (nothing persisted yet) should never emit an override warning"

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

# --- api-key mode: writes the key, writes no OAuth token ---
STAGE_API="$(mktemp -d)"
RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY=sk-ant-test-1 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_API" >/dev/null
grep -q '^RHUMB_LLM_PROVIDER=api-key$'    "$STAGE_API/rhumb.env" || fail "provider not written"
grep -q '^ANTHROPIC_API_KEY=sk-ant-test-1$' "$STAGE_API/rhumb.env" || fail "api key not written"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN='       "$STAGE_API/rhumb.env" && fail "oauth token leaked into api-key install"

# --- api-key mode requires the key ---
if RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY='' RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "empty API key should be rejected"
fi

# --- gateway mode: base URL plus explicit model, optional auth token ---
STAGE_GW="$(mktemp -d)"
RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://gw.internal:4000 \
RHUMB_MODEL=qwen3-coder ANTHROPIC_AUTH_TOKEN=bearer-xyz \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_GW" >/dev/null
grep -q '^RHUMB_LLM_PROVIDER=gateway$'                "$STAGE_GW/rhumb.env" || fail "gateway provider not written"
grep -q '^ANTHROPIC_BASE_URL=https://gw.internal:4000$' "$STAGE_GW/rhumb.env" || fail "base url not written"
grep -q '^ANTHROPIC_AUTH_TOKEN=bearer-xyz$'           "$STAGE_GW/rhumb.env" || fail "gateway auth token not written"
grep -q '^RHUMB_MODEL=qwen3-coder$'                   "$STAGE_GW/rhumb.env" || fail "gateway model not written"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN='                   "$STAGE_GW/rhumb.env" && fail "oauth token leaked into gateway install"

# --- gateway re-run is byte-identical (idempotence across the new branch) ---
cp "$STAGE_GW/rhumb.env" "$STAGE_GW/rhumb.env.first"
scripts/install.sh --dry-run --yes --stage-dir "$STAGE_GW" >/dev/null
cmp -s "$STAGE_GW/rhumb.env.first" "$STAGE_GW/rhumb.env" || fail "gateway re-run not byte-identical"

# --- ambient env value overriding a persisted one is a deliberate feature
# (--yes / CI seeding) but must warn visibly when it silently replaces a
# *different* persisted value; must stay silent when ambient == persisted or
# ambient is absent; and must never echo a secret's value either way ---
STAGE_WARN="$(mktemp -d)"
RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://correct-gateway.internal:4000 \
RHUMB_MODEL=qwen3-coder ANTHROPIC_AUTH_TOKEN=bearer-secret-1 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_WARN" >/dev/null

# mismatched ambient ANTHROPIC_BASE_URL (non-secret): warns, names both values,
# and the ambient value still wins (documented precedence, not redesigned here)
warn_out="$(RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://ambient-mismatch.internal:9000 \
RHUMB_MODEL=qwen3-coder RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_WARN" 2>&1 >/dev/null)"
printf '%s\n' "$warn_out" | grep -q 'ANTHROPIC_BASE_URL' \
  || fail "no warning for mismatched ambient ANTHROPIC_BASE_URL"
printf '%s\n' "$warn_out" | grep -q 'correct-gateway.internal:4000' \
  || fail "warning should name the persisted (non-secret) value being overridden"
grep -q '^ANTHROPIC_BASE_URL=https://ambient-mismatch.internal:9000$' "$STAGE_WARN/rhumb.env" \
  || fail "ambient value should still win over persisted (precedence is unchanged)"

# mismatched ambient ANTHROPIC_AUTH_TOKEN (secret): warns by name only, never
# echoing either the old or new token value
warn_out="$(RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://ambient-mismatch.internal:9000 \
RHUMB_MODEL=qwen3-coder ANTHROPIC_AUTH_TOKEN=bearer-secret-2 RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_WARN" 2>&1 >/dev/null)"
printf '%s\n' "$warn_out" | grep -q 'ANTHROPIC_AUTH_TOKEN' \
  || fail "no warning for mismatched ambient ANTHROPIC_AUTH_TOKEN"
printf '%s\n' "$warn_out" | grep -q 'bearer-secret' \
  && fail "secret value leaked into warning output"

# ambient ANTHROPIC_BASE_URL now matches the persisted value -> no warning
warn_out="$(RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://ambient-mismatch.internal:9000 \
RHUMB_MODEL=qwen3-coder RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_WARN" 2>&1 >/dev/null)"
printf '%s\n' "$warn_out" | grep -q 'ANTHROPIC_BASE_URL is set in the environment' \
  && fail "warning fired even though ambient value matches the persisted value"

# no ambient credential vars at all -> silent, and re-run stays byte-identical
cp "$STAGE_WARN/rhumb.env" "$STAGE_WARN/rhumb.env.before"
warn_out="$(RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_WARN" 2>&1 >/dev/null)"
printf '%s\n' "$warn_out" | grep -qE 'ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN' \
  && fail "warning fired even though no ambient credential vars were set"
cmp -s "$STAGE_WARN/rhumb.env.before" "$STAGE_WARN/rhumb.env" \
  || fail "re-run without ambient vars should be byte-identical"

rm -rf "$STAGE_WARN"

# --- mode change between runs: the previous mode's credential var is
# dropped from rhumb.env (the writer only emits the selected mode's vars),
# it is NOT "overridden" — so no override warning should mention it, even
# when an ambient value for it is still exported from the old mode ---
STAGE_SWITCH="$(mktemp -d)"
RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://gw-orig.internal:4000 \
RHUMB_MODEL=qwen3-coder RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_SWITCH" >/dev/null

# switch gateway -> subscription with a stale, mismatched ambient
# ANTHROPIC_BASE_URL still exported (as if left over from a gateway shell) —
# this is the exact scenario from the review finding
switch_err="$(RHUMB_LLM_PROVIDER=subscription CLAUDE_CODE_OAUTH_TOKEN=tok-switch-1 \
ANTHROPIC_BASE_URL=https://totally-different.example:9999 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_SWITCH" 2>&1 >/dev/null)"

grep -q '^RHUMB_LLM_PROVIDER=subscription$' "$STAGE_SWITCH/rhumb.env" \
  || fail "mode switch: provider not updated to subscription"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=tok-switch-1$' "$STAGE_SWITCH/rhumb.env" \
  || fail "mode switch: new mode's credential not written"
grep -q '^ANTHROPIC_BASE_URL=' "$STAGE_SWITCH/rhumb.env" \
  && fail "mode switch: old mode's credential should be dropped, not persisted"
printf '%s\n' "$switch_err" | grep -q 'ANTHROPIC_BASE_URL' \
  && fail "mode switch: must not warn about a var irrelevant to the newly selected mode"

# switch back subscription -> gateway with a stale ambient
# CLAUDE_CODE_OAUTH_TOKEN still exported from the previous mode
switch_err="$(RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://gw-new.internal:5000 \
RHUMB_MODEL=qwen3-coder CLAUDE_CODE_OAUTH_TOKEN=tok-stale \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_SWITCH" 2>&1 >/dev/null)"

grep -q '^RHUMB_LLM_PROVIDER=gateway$' "$STAGE_SWITCH/rhumb.env" \
  || fail "mode switch: provider not updated back to gateway"
grep -q '^ANTHROPIC_BASE_URL=https://gw-new.internal:5000$' "$STAGE_SWITCH/rhumb.env" \
  || fail "mode switch: new mode's credential not written on switch back"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$STAGE_SWITCH/rhumb.env" \
  && fail "mode switch: old mode's credential should be dropped, not persisted, on switch back"
printf '%s\n' "$switch_err" | grep -q 'CLAUDE_CODE_OAUTH_TOKEN' \
  && fail "mode switch: must not warn about a var irrelevant to the newly selected mode (switch back)"

rm -rf "$STAGE_SWITCH"

# --- unknown provider is rejected ---
if RHUMB_LLM_PROVIDER=ollama RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "unknown provider should be rejected"
fi

rm -rf "$STAGE_API" "$STAGE_GW"

echo "PASS install-dry-run"
