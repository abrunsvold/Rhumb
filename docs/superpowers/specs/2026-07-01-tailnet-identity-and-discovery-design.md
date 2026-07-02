# Tailnet identity + zero-entry connection — design

**Date:** 2026-07-01
**Status:** Approved (brainstorm 2026-07-01)
**Scope:** Connection discovery + host authentication. UI redesign is explicitly out of scope (separate cycle).

## Problem

Two related gaps, one root cause:

1. **Connection UX.** The client's ConnectionScreen
   (`client/src/components/ConnectionScreen.tsx`) requires the operator to
   hand-type two base URLs (agent host `:8787`, dashboard host `:8788`) plus an
   optional control token. The two-host process split leaks into the UX.
2. **Weak host auth.** Both hosts are unauthenticated by default. The control
   token (`RHUMB_CONTROL_TOKEN`) is opt-in, shared, and duplicated
   (`agent-host/src/auth.ts`, `dashboard-host/src/auth.ts`). Everything runs
   plain HTTP, which forces the macOS ATS exception
   (`NSAllowsArbitraryLoadsInWebContent` in `client/src-tauri/Info.plist`).
   SECURITY.md documents the consequences: any tailnet device can read the
   registry, scrape a surface's capability token, and — when no control token is
   set — drive the agent and approve gated operations.

The root cause: Rhumb treats Tailscale as a wire. Tailscale is also an identity
provider (per-request user attribution), a discovery mechanism (peer
enumeration), and a certificate authority (publicly trusted `ts.net` HTTPS).
This design adopts all three.

## Approach: `tailscale serve` as the front door

Both hosts bind **loopback only**. `tailscale serve` terminates TLS on the
box's MagicDNS hostname and reverse-proxies into them:

```
https://box.<tailnet>.ts.net/            → 127.0.0.1:8788  (dashboard host, at root)
https://box.<tailnet>.ts.net/agent/*     → 127.0.0.1:8787  (agent host)
```

The **dashboard host mounts at root** so surfaces' absolute-path calls
(`/data/...`, `/surfaces/...`, `/services/...`) keep working without content
rewriting. The agent host mounts under `/agent`; only the client's Rust proxy
calls it, so prefixing is contained to one place.

What this buys:

- **Identity headers.** Serve injects `Tailscale-User-Login` (and strips any
  inbound `Tailscale-*` headers from callers, so they cannot be spoofed from
  the tailnet). Hosts authenticate every request against an operator allowlist.
- **Real HTTPS.** Publicly trusted `ts.net` certificates. The ATS exception in
  `Info.plist` is **deleted** (ATS already exempts localhost for dev).
- **Single origin.** The client stores one base URL. The two-host split becomes
  an internal detail.
- **Port hardening.** `:8787`/`:8788` are unreachable from the tailnet; the
  only network path in is through serve.

### Alternatives considered

- **In-process `whois`** (hosts query tailscaled's LocalAPI per connection):
  no serve dependency, but keeps two ports, no TLS (ATS exception stays), and
  more security-critical code to own. Rejected.
- **Custom gateway daemon** doing whois + LocalAPI certs: rebuilds what serve
  already is. Rejected.

## Components

### 1. Shared identity middleware (both hosts)

A single `tailnetIdentity` middleware replaces the duplicated
`createControlTokenGuard` files as the **primary** auth layer:

- Reads `Tailscale-User-Login`; the request is authenticated as that login.
- Compares against `RHUMB_ALLOWED_USERS` (comma-separated tailnet login names).
  Match → attach identity to the request and continue. No header or no match →
  `403`.
- Applies to **all routes** on both hosts — including the registry, surface
  serving, and `/data/*` reads that are unauthenticated today. Exceptions:
  `/healthz` and `/.well-known/rhumb.json` (presence + paths only, no secrets).
- **Fail closed at boot:** in identity mode, a host refuses to start when
  `RHUMB_ALLOWED_USERS` is unset or empty.

Trust in the header rests on the loopback bind: only serve can reach the
hosts over the network, and serve strips caller-supplied `Tailscale-*`
headers. Processes already on the box (including the agent's own Bash) can
reach loopback and forge headers — they are inside the trust boundary today
(they can already touch the workspace and ports directly), so this is not a
regression; SECURITY.md must state it.

**Dev escape hatch:** `RHUMB_INSECURE_DEV=1` restores today's behavior
(non-loopback bind allowed, control-token-optional auth) with a loud startup
warning. The control token survives only under this flag; identity mode is the
default posture and ignores it.

**Existing gates unchanged in shape, upgraded in strength:** the pending-write
and infra approval routes stay operator-only; "operator" is now an
identity-verified allowlisted login rather than a bearer of an optional shared
secret. The per-surface capability token is retained but **demoted from auth
boundary to scoping/audit label** — it identifies *which surface* is calling,
while *who may call at all* is the identity layer. This closes the documented
scrape-the-token gap: scraping now requires being an allowlisted device.

### 2. Well-known manifest (dashboard host)

`GET /.well-known/rhumb.json` (unauthenticated):

```json
{
  "rhumb": true,
  "version": "<package version>",
  "paths": { "agent": "/agent", "dashboard": "/" }
}
```

This is the discovery beacon and the indirection that lets the client learn
both hosts from one origin. No secrets, no workspace data.

### 3. `rhumb setup` (server-side, one-time)

An idempotent script/subcommand on the box that:

- Verifies tailscaled is running, MagicDNS + HTTPS certs are enabled on the
  tailnet (prints actionable errors when not).
- Applies the serve config (root → 8788, `/agent` → 8787).
- Prints the resulting origin (`https://box.<tailnet>.ts.net`) and the
  `RHUMB_ALLOWED_USERS` value it detected for the current login as a suggested
  default.

Exact `tailscale serve` flag syntax is an implementation detail (it varies by
version); behavior above is the contract.

### 4. Client: discovery picker

The ConnectionScreen becomes a picker:

- **Rust side:** locate the Tailscale CLI (macOS app bundle path,
  `/usr/local/bin`, `/usr/bin`, `$PATH`), run `tailscale status --json`,
  extract online peers' MagicDNS names. Probe
  `https://<peer>/.well-known/rhumb.json` with bounded concurrency (~8) and a
  short timeout (~1.5 s); a response with `"rhumb": true` is a hit.
- **UI:** discovered boxes render as one-click connect cards (hostname +
  version). Selecting one runs the existing health checks and persists config.
- **Fallbacks, in order:** CLI missing or zero hits → manual entry of a
  *single* base URL (the client fetches the manifest from it to learn paths);
  manifest fetch fails → clear error. The token field disappears from the
  default flow (dev builds may expose it behind the dev flag).

Persisted `AppConfig` shrinks from `{agentBase, dashboardBase, controlToken?}`
to `{baseUrl, paths}` (with a legacy-config migration: existing two-URL configs
are discarded and the user re-connects via the picker — acceptable for
pre-release software). The Rust proxy derives agent/dashboard bases from
`baseUrl + paths`.

### 5. Removals

- macOS ATS exception (`NSAllowsArbitraryLoadsInWebContent`) — deleted.
- Duplicated `auth.ts` control-token guards as the primary layer — replaced by
  the shared identity middleware (token logic retained solely for the dev
  flag).
- SECURITY.md rewritten: unauthenticated-hosts section replaced by the identity
  model, its loopback assumption, and the on-box trust boundary note.

## Data flow (connect)

1. Client launches → Rust proxy runs `tailscale status --json` → probes online
   peers for the manifest → UI lists hits.
2. Operator clicks a box → health checks via serve origin → config persisted.
3. Every subsequent request (chat, registry, surfaces, data, approvals) flows
   `client → serve (TLS, identity injected) → loopback host (allowlist check)`.
4. Surfaces load in the webview over HTTPS from the same origin; their `/data/*`
   calls carry the operator device's tailnet identity implicitly, plus the
   per-surface token as the scoping label.

## Error handling

- Host boot without `RHUMB_ALLOWED_USERS` (identity mode) → refuse to start
  with an instructive message.
- Request without identity header / non-allowlisted login → `403` JSON error;
  never a silent pass.
- Discovery: per-peer timeouts are non-fatal; zero hits degrades to manual
  entry with a hint ("is `rhumb setup` done on the box?").
- Manifest unreachable on manual URL → explicit error naming the URL probed.

## Testing

- **Middleware unit tests:** allowlisted login passes; missing header 403;
  wrong login 403; healthz + well-known bypass; boot fails closed without
  allowlist; dev flag restores token behavior with warning.
- **Manifest endpoint test:** shape + unauthenticated access.
- **Rust discovery tests:** status-JSON parsing, probe result filtering,
  CLI-missing fallback.
- **Client tests:** picker renders discovered boxes; manual single-URL fallback
  fetches manifest; legacy config migration drops old shape.
- **Manual smoke:** `rhumb setup` on the box → discovery from the laptop →
  connect → chat turn → surface loads over HTTPS → pending-write approval, all
  with ATS exception removed.

## Out of scope

- UI/UX redesign of the shell (separate design cycle).
- Multi-user / multi-operator identity roles.
- Funnel (public internet) exposure — explicitly unsupported; serve only.
- In-process whois mode.
- Mobile clients (though the manifest + identity model is the foundation they
  will use).

## Addendum (2026-07-02): shell-vs-surface discrimination

Tailnet identity is per-device, and surfaces execute on the operator's device —
so identity alone cannot keep a malicious surface from calling the approval
routes. Approval routes (`/data/pending/*`, `/infra/*` — and on the agent host,
all routes) therefore additionally require the `Sec-Rhumb-Control: 1` header.
The Fetch standard forbids page JavaScript from setting `Sec-*` request
headers, so surface content can never present it; the client's Rust proxy sends
it on every request. This supersedes the spec's implication that identity alone
gates the approval plane, and removes any need for a shared secret in the
default flow.
