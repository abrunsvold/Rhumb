# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/abrunsvold/Rhumb/security/advisories/new)
(Security → Report a vulnerability on the repository). We aim to acknowledge a
report within a few days and will coordinate a fix and disclosure timeline with
you.

When reporting, please include: the affected component (`agent-host`,
`dashboard-host`, or `client`), the version/commit, reproduction steps, and the
impact you observed.

## Supported versions

Rhumb is early-stage software under active development. Security fixes are
applied to the `main` branch only; there are no long-term support branches yet.

## Threat model — read this before deploying

Rhumb is a **self-hosted personal tool**, and its security model assumes a
**single trusted operator on a private [Tailscale](https://tailscale.com)
tailnet**. Several design choices only hold under that assumption:

- **The hosts are unauthenticated.** The agent host (`/messages`, `/infra/*`)
  and the dashboard host (`/data/*`, `/services/*`, `/registry`) do not
  authenticate callers. Anyone who can reach the ports can drive the agent,
  approve gated infrastructure actions, and read/write data. **Expose these
  services only over your tailnet — never on a public or LAN-facing interface.**
- **The agent runs autonomously with Bash and Write access.** `RHUMB_PERMISSION_MODE`
  controls gating; `bypassPermissions` removes it entirely. Only use
  `bypassPermissions` in a fully trusted, isolated environment.
- **Agent-built surfaces are treated as untrusted content.** They render in the
  desktop client and are served by the dashboard host. Scope the Postgres role
  behind any data source to least privilege, since a surface can issue reads and
  (once approved) writes against whatever that role can reach.
- **Credentials come only from the environment**, never from the repo. Keep your
  `CLAUDE_CODE_OAUTH_TOKEN`, Proxmox tokens, and database credentials in a local
  `.env` or your process manager — they are git-ignored by default.

See [`README.md`](README.md) and [`COMPLIANCE.md`](COMPLIANCE.md) for the full
operational security and compliance model.

### Surface data authorization

Surfaces authenticate to the data endpoint (`/data/*`) with a **per-surface
capability token** that the dashboard injects into each surface's served HTML;
the token — not the `Referer` header — identifies the calling surface and gates
read/write access. Because surfaces are served openly on the tailnet, this is not
perfectly unforgeable: **an attacker who can `GET` a specific surface can scrape
that surface's token and act as that surface.** That is inherent to serving
surfaces on an unauthenticated host, and it is the accepted limit. The dangerous
*actions* — approving pending writes and infrastructure operations — remain gated
by the separate control token (`RHUMB_CONTROL_TOKEN`), which is never served to a
surface.

### Desktop client webview posture

The macOS client ships an App Transport Security exception scoped to web
content (`NSAllowsArbitraryLoadsInWebContent` in `client/src-tauri/Info.plist`)
so the webview can frame surfaces served over plain HTTP on the tailnet — the
same threat model as above; the app shell itself still loads only bundled
assets. With ATS relaxed, the controls on framed surface content are the
shell's CSP, the iframe `sandbox` attribute, and Tauri's capability scoping:
the only capability (`client/src-tauri/capabilities/default.json`) is bound to
`"windows": ["main"]`, so sandboxed iframes and detached `surface:*` windows
get no Tauri IPC — including the `create-webview-window` permission the main
window uses for Detach. Do not add a capability whose `windows` matches
`surface:*`, and re-verify the iframe/IPC origin separation before shipping a
Linux build (WebKitGTK cannot always distinguish iframe IPC from top-window
IPC).

### Known hardening gaps

Rhumb is **not yet hardened for hostile networks**. Remaining gaps we are tracking
(all mitigated in practice by the tailnet-only, single-operator assumption above)
include: the control plane is authenticated only when `RHUMB_CONTROL_TOKEN` is
set, and surface isolation relies on the browser/webview origin plus the
per-surface token described above. Do not deploy Rhumb anywhere the tailnet-only
assumption does not hold.
