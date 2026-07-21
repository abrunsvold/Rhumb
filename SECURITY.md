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

- **Hosts authenticate every request against a Tailscale identity allowlist.**
  In the default (identity) mode both hosts bind loopback only and are fronted
  by `tailscale serve`, which terminates TLS and injects an unforgeable
  `Tailscale-User-Login` header (serve strips any caller-supplied
  `Tailscale-*` headers). Requests from logins not in `RHUMB_ALLOWED_USERS`
  are rejected; hosts refuse to start with an empty allowlist. Processes
  already running on the box can reach loopback directly and are inside the
  trust boundary — unchanged from before, since they already have workspace
  and credential access. `RHUMB_INSECURE_DEV=1` disables all of this for
  local development only.
- **The agent runs autonomously with Bash and Write access.** `RHUMB_PERMISSION_MODE`
  controls gating; `bypassPermissions` removes it entirely. Only use
  `bypassPermissions` in a fully trusted, isolated environment.
- **Agent-built surfaces are treated as untrusted content.** They render in the
  desktop client and are served by the dashboard host. Scope the Postgres role
  behind any data source to least privilege, since a surface can issue reads and
  (once approved) writes against whatever that role can reach.
- **Credentials come only from the environment**, never from the repo. Keep your
  Claude credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
  `ANTHROPIC_AUTH_TOKEN` depending on `RHUMB_LLM_PROVIDER`), Proxmox tokens, and
  database credentials in a local `.env` or your process manager — they are
  git-ignored by default. The agent subprocess receives only the selected
  provider's credentials and no `RHUMB_*` var.

See [`README.md`](README.md) and [`COMPLIANCE.md`](COMPLIANCE.md) for the full
operational security and compliance model.

### Surface data authorization

Serving a surface at all now requires an allowlisted tailnet identity, so the
per-surface token can no longer be scraped by arbitrary tailnet devices. The
token still identifies *which* surface is calling `/data/*` (scoping + audit).
The dangerous *actions* — approving pending writes and infrastructure
operations — additionally require the `Sec-Rhumb-Control: 1` request header.
Browsers forbid page JavaScript from setting `Sec-*` headers, so agent-built
surface content cannot present it; only the desktop client's Rust proxy does.
This replaces the optional `RHUMB_CONTROL_TOKEN` as the shell/surface
boundary (the token now applies only in `RHUMB_INSECURE_DEV=1` mode).

### Schema changes (DDL)

The `/data` write gate covers DML only. Schema changes (CREATE/ALTER/DROP)
issued through the agent's own tools — e.g. a migration script run via Bash
with an owner-role connection — execute **without an approval gate**. This is
a deliberate posture, not an oversight: schema migrations are core to how the
agent builds and evolves tools, and today the agent only runs during turns the
operator started. Two compensating controls apply. Every provisioned database
carries superuser-owned event triggers (`_rhumb.ddl_audit`) that record each
DDL statement with its acting role; the owner role can neither read nor tamper
with that record. And the record is surfaced: the System map's datasource
entries show the most recent schema change and a 7-day count (databases
provisioned before the audit feature display "not installed"). A hard DDL gate
(owner roles without CREATE plus an operator-approved `apply_ddl` path) is
planned together with unattended/scheduled agent sessions, where the
operator-initiated-turns assumption no longer holds.

### Desktop client webview posture

The macOS client no longer ships an App Transport Security exception for web
content: in identity mode, both hosts sit behind `tailscale serve`, so the
webview frames surfaces over real tailnet HTTPS rather than plain HTTP, and
the `NSAllowsArbitraryLoadsInWebContent` entry has been removed from
`client/src-tauri/Info.plist`. The app shell itself still loads only bundled
assets. The controls on framed surface content are the shell's CSP, the
iframe `sandbox` attribute, and Tauri's capability scoping: the only
capability (`client/src-tauri/capabilities/default.json`) is bound to
`"windows": ["main"]`, so sandboxed iframes and detached `surface:*` windows
get no Tauri IPC — including the `create-webview-window` permission the main
window uses for Detach. Do not add a capability whose `windows` matches
`surface:*`, and re-verify the iframe/IPC origin separation before shipping a
Linux build (WebKitGTK cannot always distinguish iframe IPC from top-window
IPC). `RHUMB_INSECURE_DEV=1` still serves over plain HTTP for local
development; do not run that mode on a box reachable by anyone else.

### Known hardening gaps

Rhumb is **not yet hardened for hostile networks**. Remaining gaps we are tracking
(all mitigated in practice by the tailnet-only, single-operator assumption above)
include: identity is per-*device*, not per-request-origin within that device, so
any process on an allowlisted operator's machine — including a rogue browser tab
or a compromised local app — can reach the hosts with that operator's identity;
`RHUMB_ALLOWED_USERS` is a flat allowlist with no role separation, so every
allowlisted login has full operator privileges; and `RHUMB_INSECURE_DEV=1`, while
intended for local development only, has no runtime check preventing it from
being set on a network-reachable box. Do not deploy Rhumb anywhere the
tailnet-only, single-operator assumption does not hold.
