# RHUMBR Dashboard Host

Watches the RHUMBR workspace and serves the `file` surfaces Claude Code builds at
stable URLs over your Tailscale network, plus the registry the desktop client reads.

> **Security.** This host is **unauthenticated** — it serves whatever is under
> `<workspace>/surfaces/`. Expose it **only** on your tailnet, never on a public
> interface. It does not call Claude and holds no credentials.

## Run

    npm install
    npm run build
    npm start

Environment variables: `RHUMBR_DASHBOARD_PORT` (default 8788), `RHUMBR_WORKSPACE`
(default `./workspace`).

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
