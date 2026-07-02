#!/usr/bin/env bash
# Rhumb one-time server setup: put both hosts behind `tailscale serve` so the
# client reaches a single HTTPS origin with Tailscale identity headers.
# Idempotent: re-running replaces the same two mounts.
set -euo pipefail

AGENT_PORT="${RHUMB_PORT:-8787}"
DASH_PORT="${RHUMB_DASHBOARD_PORT:-8788}"

command -v tailscale >/dev/null 2>&1 || {
  echo "error: tailscale CLI not found. Install Tailscale on this box first." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "error: python3 not found (needed to parse tailscale status)." >&2
  exit 1
}
tailscale status >/dev/null 2>&1 || {
  echo "error: tailscaled is not running or this box is not logged in. Run: tailscale up" >&2
  exit 1
}

# NOTE: serve keeps the original request path (no prefix stripping); the agent
# host normalizes its /agent prefix itself.
tailscale serve --bg --set-path=/agent "http://127.0.0.1:${AGENT_PORT}"
tailscale serve --bg "http://127.0.0.1:${DASH_PORT}"

STATUS_JSON="$(tailscale status --json)"
DNS_NAME="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
LOGIN="$(printf '%s' "$STATUS_JSON" | python3 -c '
import json, sys
s = json.load(sys.stdin)
users = s.get("User") or {}
uid = str(s.get("Self", {}).get("UserID", ""))
print((users.get(uid) or {}).get("LoginName", ""))
')"

echo
echo "Rhumb is served at: https://${DNS_NAME}"
echo "  dashboard host  -> /"
echo "  agent host      -> /agent"
echo
echo "Set on BOTH hosts before starting them:"
echo "  RHUMB_ALLOWED_USERS=${LOGIN:-<your-tailnet-login>}"
echo
echo "If the HTTPS cert fails on first request, enable HTTPS certificates for"
echo "your tailnet: https://login.tailscale.com/admin/dns (MagicDNS + HTTPS)."
