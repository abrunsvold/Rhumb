# Surface Isolation — Design Spec

**Date:** 2026-07-01
**Status:** Draft for review
**Scope:** Tier 2 security hardening — the surface ↔ control/data trust boundary

---

## 1. Summary

Agent-built **surfaces** are untrusted HTML/JS served by the dashboard host and
rendered in the desktop client. Today they run **same-origin** with the control
and data plane, and the data endpoint decides write-trust from the request
`Referer` header. Two problems follow:

- **`Referer` is forgeable.** Any device on the tailnet can send
  `Referer: …/surfaces/<trusted-id>/…` to `/data/:source/write` and have the
  write execute directly, with no operator approval.
- **A malicious surface runs with the dashboard origin**, so its JS can read
  `/data/:source/query`, and (before the control-token work) reach the approval
  routes.

The control-token work already landed (`RHUMB_CONTROL_TOKEN`) closes the
approval-route path: surfaces can no longer approve their own pending writes.
This spec covers the remaining boundary: **replace the forgeable `Referer`
write-trust signal with a per-surface capability token, and constrain what a
served surface can do with security headers.**

This is deliberately *lighter hardening* suited to a single-operator, tailnet-only
personal tool. It keeps the zero-click "trusted surface writes directly"
convenience rather than routing every write through approval.

### Threat model and honest limits

The dashboard host is **unauthenticated and serves surfaces openly on the
tailnet**. Any secret embedded in a surface's served HTML can therefore be
scraped by an attacker who can `GET` that surface. The per-surface token is not
perfectly unforgeable; it raises forgery from "set one header with a guessable
surface id" to "fetch and parse that specific surface, then replay its token."
That is the strongest guarantee available on an open host, and it is the accepted
posture. The dangerous *actions* (approvals, infra) remain gated by the
control-token, which is never served to a surface.

---

## 2. Components

### 2.1 Per-surface capability token (dashboard host)

- **Generation & storage.** Each surface has a random token (≥128 bits, URL-safe).
  It is generated on first serve and persisted to a sidecar file
  `<workspace>/surfaces/<id>/.surface-token` so it is stable across restarts and
  re-serves. The token is **not** placed in `surface.json` (which is
  agent-writable and surfaced in listings) and **never** appears in `/registry`.
- **Injection.** When the dashboard serves a surface's **entry HTML** (only the
  HTML document, not other assets), it injects a small shim `<script>` at the top
  of `<head>` (or, absent a `<head>`, prepended to the document). The shim:
  - stores `{ surfaceId, token }` on a namespaced global (e.g. `window.__RHUMB__`)
    and in a `<meta name="rhumb-surface-token">` for surfaces that prefer to read
    it directly, and
  - monkeypatches `window.fetch` and `XMLHttpRequest.prototype.open/send` to
    attach the header `X-Rhumb-Surface-Token: <token>` on **same-origin
    `/data/*`** requests only (never on cross-origin requests, so the token is
    not leaked off-host).
- **Result:** a surface that calls `fetch('/data/ops/query', …)` works unchanged.
  The surface-authoring contract does not change.

### 2.2 Data endpoint auth by token (dashboard host)

- `/data/:source/query` and `/data/:source/write` resolve the **calling surface
  id from the `X-Rhumb-Surface-Token` header**, by looking the token up against
  the known surfaces. A missing or unrecognized token → `surfaceId = null`.
- **Query:** requires a valid token (i.e. `surfaceId !== null`); otherwise `401`.
  This stops a tokenless `curl` on the tailnet from reading data. (Reads still
  need no operator confirmation once the caller is a known surface.)
- **Write:** unchanged trust logic, but keyed on the **token-derived** surfaceId:
  trusted `(source, surfaceId)` → execute; otherwise enqueue for approval. A
  tokenless write → `surfaceId = null` → always enqueues (never executes).
- **`Referer` becomes advisory.** `surfaceIdFromReferer` is retained only for
  audit/display context, never for an authorization decision.

### 2.3 Security headers on served surfaces (dashboard host)

Every surface response carries:

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy` whose load-bearing directives are:
  - `connect-src 'self'` — a malicious surface cannot exfiltrate data or its own
    token to an external server.
  - `frame-ancestors <app-origins>` — **only the Tauri app may frame a surface**.
    This is set to the Tauri webview origins (`tauri://localhost` on macOS,
    `https://tauri.localhost` on Windows/Linux), configurable via
    `RHUMB_APP_ORIGINS` (comma-separated), defaulting to that known set. It is
    deliberately **not** `'self'`: two surfaces share the dashboard origin, so
    `'self'` would let one surface frame another (the clickjacking vector we want
    to block) while wrongly excluding the app, which is a different origin.
  - `script-src`/`style-src` stay permissive (`'self' 'unsafe-inline'`) so
    agent-built surfaces that use inline scripts/styles keep working. The isolation
    value comes from `connect-src`/`frame-ancestors`, not from locking down script.

### 2.4 Client (Tauri) — verified in the Tauri dev environment

- **C2 (detach).** Detached surface `WebviewWindow`s must inherit **no** Tauri
  capabilities. Confirm the capability file (`capabilities/default.json`, scoped
  to `"windows": ["main"]`) grants nothing to the `surface:*` window label; add an
  explicit deny/label check if needed. Detach stays, but isolated.
- **C1 (iframe).** *Keep* `sandbox="allow-scripts allow-same-origin"`. This is now
  safe because: the app shell is a different origin (`tauri://…`) so a surface
  cannot script it; per-surface tokens isolate data access between surfaces; and
  §2.3's `connect-src 'self'` blocks exfiltration. Replace the misleading test
  comment in `Canvas.test.tsx` with the rationale.
- **App-shell CSP.** `frame-src` must still permit the (runtime-configured)
  dashboard origin, so it remains scheme-broad; the real per-surface constraint is
  §2.3. Optionally tighten the app-shell `img-src` to `'self' data:`.

---

## 3. Data flow (write path, after this change)

1. Surface JS calls `fetch('/data/ops/write', { method: 'POST', body: { op } })`.
2. The injected shim attaches `X-Rhumb-Surface-Token: <token>`.
3. Dashboard resolves token → `surfaceId`. Unknown → enqueue (untrusted).
4. If `(ops, surfaceId)` is trusted → execute + audit; else enqueue a pending
   write. Operator approves pending writes via the control-token-gated
   `/data/pending/:id/resolve` (already implemented).

---

## 4. What this closes / accepts

**Closes:** forgeable-`Referer` direct writes; tokenless data reads by a tailnet
`curl`; data/token exfiltration from a malicious surface (`connect-src 'self'`);
surface clickjacking (`frame-ancestors`); the C2 unsandboxed-webview capability
risk.

**Accepts (documented in SECURITY.md):** an attacker who can `GET` a specific
surface's HTML can scrape that surface's token and act *as that surface*. This is
inherent to serving surfaces openly on an unauthenticated host; the control-token
still gates the dangerous approve/infra actions.

---

## 5. Testing

- **Dashboard (unit/integration, in this environment):**
  - The shim is injected into served entry HTML (and only HTML), including when
    the document has no `<head>`.
  - A surface token is generated, persisted, and stable across re-serves; it does
    not appear in `/registry`.
  - `/data/query` and `/data/write` require a valid `X-Rhumb-Surface-Token`;
    tokenless/invalid → `401` (query) / enqueue (write).
  - Write-trust is keyed on the token-derived surfaceId; a forged `Referer` with
    no token does not authorize a direct write.
  - Security headers (`nosniff`, CSP with `connect-src 'self'`, `frame-ancestors`)
    are present on surface responses.
- **Client (Tauri, verified by the operator):** detached surface windows have no
  Tauri capabilities; surfaces still load and can call `/data`.

---

## 6. Out of scope

- Serving surfaces from a separate origin/port (the "full isolation" option) —
  deliberately deferred; single-origin + tokens is the chosen posture.
- Removing the trusted-surface direct-write convenience — retained by choice.
- The remaining client/Rust fixes tracked separately (proxy base-URL pinning;
  the client sending the control-token header); those are not part of this spec
  but will be implemented in the same Tauri-verified pass.
