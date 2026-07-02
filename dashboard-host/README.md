# Rhumb Dashboard Host

Watches the Rhumb workspace and serves the `file` surfaces Claude Code builds at
stable URLs over your Tailscale network, plus the registry the desktop client reads.

> **Security.** In the default (identity) mode this host binds loopback only and
> sits behind `tailscale serve`, which terminates TLS and injects an unforgeable
> `Tailscale-User-Login` header; every request must come from a login in
> `RHUMB_ALLOWED_USERS` or it is rejected, and the host refuses to start without
> that allowlist set. `/healthz` and `/.well-known/rhumb.json` are open (no
> identity needed) so discovery and health checks work before you're allowlisted.
> Everything else — including serving whatever is under `<workspace>/surfaces/` —
> requires an allowlisted identity. The write-approval plane (approving pending
> writes and infra operations) is gated further behind the `Sec-Rhumb-Control: 1`
> header, which only the desktop client's Rust proxy can set. `RHUMB_INSECURE_DEV=1`
> is a dev-only escape hatch: it disables the identity allowlist and the
> loopback-only bind (binding all interfaces instead) and falls back to the
> optional `RHUMB_CONTROL_TOKEN` for the write-approval plane. It does not call
> Claude and holds no Claude credentials. See [`SECURITY.md`](../SECURITY.md)
> for the full threat model.

## Run

    npm install
    npm run build
    RHUMB_ALLOWED_USERS=you@github npm start

Environment variables: `RHUMB_DASHBOARD_PORT` (default 8788), `RHUMB_WORKSPACE`
(default `./workspace`), `RHUMB_ALLOWED_USERS` (comma-separated tailnet logins,
e.g. `alice@github`; **required** in the default identity mode — the host
refuses to start without it), `RHUMB_INSECURE_DEV` (set to `1` to skip the
identity allowlist and loopback-only bind; **local development only**, never
on a box reachable by anyone else).

## Surface contract

The agent creates a surface by writing a folder `<workspace>/surfaces/<id>/`:

    surface.json   { "id", "title", "kind": "file", "entry": "index.html", "created", "updated" }
    index.html     (and any other static assets)

`id` must equal the folder name and match `[A-Za-z0-9._-]+`. Invalid or partial
surfaces are skipped, never fatal.

## API

- `GET /registry` — `{ surfaces: [{ id, title, url, kind, created, updated }] }`.
- `GET /registry/stream` — Server-Sent Events; a fresh registry snapshot on connect
  and on every change.
- `GET /surfaces/:id/` (and `/surfaces/:id/<asset>`) — the surface's static files;
  a bare directory serves its `entry`. Paths outside the surface folder are refused.
- `GET /healthz` — `{ ok: true }`.
