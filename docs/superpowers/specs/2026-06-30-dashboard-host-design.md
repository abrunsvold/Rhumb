# Dashboard Host Design Spec (RHUMBR — Plan 2 of 7)

**Date:** 2026-06-30
**Status:** Approved design (sub-spec of the RHUMBR master spec §3.2)
**Depends on:** the `RHUMBR_WORKSPACE` file-as-contract folder established by the agent host (Plan 1).

---

## 1. Role

The **dashboard host** is the second server-side process on the Proxmox box. It watches the workspace, serves the `file` surfaces Claude Code builds at stable tailnet URLs, and exposes the **registry** the Tauri client reads to list and render surfaces. It is its own process behind an HTTP contract (polyglot-by-contract); the first implementation is TypeScript/Node + Express, matching the agent host.

This plan implements **`file` surfaces only**. The registry contract carries a `kind` field so container-isolated `service` surfaces (Plan 6) slot in later with no contract change. There is no data endpoint yet (Plan 4).

## 2. Surface layout (the agent↔host contract)

Claude Code (the agent) materializes a surface by writing a self-contained folder into the workspace:

```
<RHUMBR_WORKSPACE>/surfaces/<id>/
  surface.json        # metadata (see below)
  index.html          # the entry artifact (name set by surface.json.entry)
  ...                 # any other static assets it references
```

`surface.json`:

```json
{
  "id": "string (matches the folder name; URL-safe: [A-Za-z0-9._-]+)",
  "title": "string (human label for the tab)",
  "kind": "file",
  "entry": "index.html",
  "created": "ISO-8601 string",
  "updated": "ISO-8601 string"
}
```

- The folder is the unit of atomicity: the agent drops a complete folder; there is no central file to corrupt.
- `id` MUST equal the folder name and MUST match `^[A-Za-z0-9._-]+$` (rejects path-traversal and separators).
- A folder missing or with an invalid `surface.json` is **skipped** (logged), not fatal — a half-written surface never breaks the registry.

## 3. HTTP surface

- **`GET /registry`** → `{ "surfaces": [ { id, title, url, kind, created, updated } ] }`.
  - `url` is the relative path `/surfaces/<id>/`. The client joins it with the tailnet `host:port`.
  - Built from the current in-memory registry (kept fresh by the watcher, §4).
- **`GET /registry/stream`** → Server-Sent Events. Emits one `registry` event (the full `{ surfaces: [...] }` snapshot) on connect, then a fresh snapshot whenever the watcher detects a change. Mirrors the agent host's SSE pattern so the client's tab list updates live.
- **`GET /surfaces/:id/`** and **`GET /surfaces/:id/<path>`** → serves static files from `<workspace>/surfaces/<id>/`. A bare directory request serves that surface's `entry` file. A path-traversal guard resolves the requested path and rejects anything that escapes the surface folder (404).
- **`GET /healthz`** → `{ ok: true }`.

## 4. Live registry (watcher)

The host maintains an **in-memory registry** (a `Map<id, SurfaceMeta>`):

- On startup it scans `<workspace>/surfaces/*/surface.json` to seed the registry.
- A file watcher on `<workspace>/surfaces/` rebuilds/updates the affected entry on add/change/unlink (debounced to coalesce multi-file writes within one surface).
- Each registry mutation pushes a fresh snapshot to all `/registry/stream` subscribers.
- The watcher is the single writer of the in-memory registry; HTTP handlers only read it.

## 5. Components (files)

- `dashboard-host/src/config.ts` — env: `RHUMBR_DASHBOARD_PORT` (default 8788), `RHUMBR_WORKSPACE` (default `./workspace`). No auth token (this host serves only over the tailnet trust boundary; it does not call Claude).
- `dashboard-host/src/types.ts` — `SurfaceMeta`, `RegistrySnapshot`, and a `RegistryEvent` (`{ type: "registry"; surfaces: SurfaceMeta[] }`) wire type.
- `dashboard-host/src/registry.ts` — the in-memory registry + `readSurfaceMeta(dir)` (parse/validate one `surface.json`) + `scanSurfaces(root)`; pure, unit-tested with a temp dir.
- `dashboard-host/src/watcher.ts` — wraps the file watcher; calls back with registry changes (the watch source is injectable for tests).
- `dashboard-host/src/sse.ts` — SSE writer for `RegistryEvent` (same shape as the agent host's).
- `dashboard-host/src/server.ts` — Express routes (`createServer(deps)` with the registry + a subscriber set injected), incl. the path-traversal-guarded static handler.
- `dashboard-host/src/index.ts` — `buildApp(deps)` + `main()` wiring config + registry + watcher + server; `import.meta.url` direct-execution guard.
- `dashboard-host/README.md` — run instructions; note that this host is unauthenticated and MUST only be exposed on the tailnet.

## 6. Data flow (core loop)

1. Claude Code writes `<workspace>/surfaces/<id>/{surface.json, index.html, ...}`.
2. The watcher fires → `readSurfaceMeta` validates the folder → the in-memory registry updates → a fresh snapshot is pushed to `/registry/stream` subscribers.
3. The client (Plan 3) reads `/registry` (or the stream) → opens a tab → its webview loads `<tailnet-host:port>/surfaces/<id>/`.
4. The dashboard host serves the surface's static files, defaulting to `entry`.

## 7. Error handling

- Invalid/partial `surface.json` → skip that surface, log, keep serving the rest.
- Missing `entry` file on a bare directory request → 404.
- Path-traversal attempt on `:id` or the sub-path → 404, never serve outside the surface folder.
- Watcher error → log and keep the last good registry; the host stays up.

## 8. Testing

- `registry.ts`: unit tests over a temp dir — valid surface parsed; invalid/missing `surface.json` skipped; `id`/folder mismatch and bad-`id` rejected.
- `server.ts`: Supertest — `/registry` shape; `/surfaces/:id/` serves `entry`; traversal attempt → 404; `/healthz`.
- `sse.ts`: single-line frame serialization (as in the agent host).
- `watcher.ts`: injected fake watch source → a simulated add triggers a registry update + snapshot push.

## 9. Out of scope (later plans)

- `service` surfaces / reverse proxy / containers → Plan 6.
- Live data / write-back endpoint → Plan 4.
- The client UI that renders these surfaces → Plan 3.
- Auth on this host beyond the tailnet boundary.
