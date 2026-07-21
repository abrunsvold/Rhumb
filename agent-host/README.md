# Rhumb Agent Host

Server-side component of Rhumb. Wraps Claude Code (via the Claude Agent SDK) and
exposes a small HTTP + SSE session API over your Tailscale network.

## Authentication — personal-tool framing

Rhumb authenticates Claude with your own subscription, an API key, or an
Anthropic-compatible gateway — set `RHUMB_LLM_PROVIDER` (`subscription` |
`api-key` | `gateway`; default `subscription`).

In subscription mode, generate a long-lived token once:

    claude setup-token

Then export it before starting the host:

    export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`

> **Compliance note (subscription mode only).** Anthropic's terms state that,
> without prior approval, third-party developers may not *offer* claude.ai login
> or rate limits in their products — including agents built on the Claude Agent
> SDK. In subscription mode Rhumb is a **self-hosted personal tool**: you run it
> on your own hardware with your own credentials. It does not broker, proxy, or
> offer Claude login to anyone else. If you want to distribute a multi-tenant or
> hosted offering in subscription mode, seek Anthropic's approval first. The
> `api-key` and `gateway` modes involve no claude.ai login, so this note doesn't
> apply to them. See [COMPLIANCE.md](../COMPLIANCE.md) for the full reasoning.

## Run

    npm install
    npm run build
    CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start   # or the api-key / gateway vars above

Environment variables: `RHUMB_LLM_PROVIDER` (default `subscription`) plus that
mode's credentials — `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`, or
`ANTHROPIC_BASE_URL` (+ optional `ANTHROPIC_AUTH_TOKEN`); `RHUMB_PORT` (default
8787), `RHUMB_MODEL` (default `claude-opus-4-8`; required in gateway mode),
`RHUMB_WORKSPACE` (default `./workspace`), `RHUMB_PERMISSION_MODE` (default
`acceptEdits`), `RHUMB_ALLOWED_USERS` (comma-separated tailnet logins, e.g.
`alice@github`; **required** in the default identity mode — the host refuses to
start without it), `RHUMB_INSECURE_DEV` (set to `1` to skip the identity
allowlist and loopback-only bind; **local development only**, never on a box
reachable by anyone else).

## Security

The agent host runs Claude Code autonomously with Bash and Write access to the
operator's machine. The `permissionMode` controls how much is gated:

- **`acceptEdits`** (default) — Claude may auto-accept file edits; dangerous
  Bash commands are still gated and require confirmation.
- **`default`** — standard interactive mode; most actions require approval.
- **`plan`** — Claude proposes a plan before executing; useful for review.
- **`bypassPermissions`** — removes all permission gating. **WARNING:** with
  this setting Claude Code can execute any Bash command or file write without
  confirmation. Only use in fully trusted, isolated environments.

Set via the `RHUMB_PERMISSION_MODE` environment variable
(`default` | `acceptEdits` | `bypassPermissions` | `plan`).

## API

- `POST /messages` — `{ "sessionId"?: string, "prompt": string }` → `202 { sessionId }`.
- `GET /sessions/:id/stream` — Server-Sent Events; each frame is one `AgentEvent`
  (`session` | `result` | `error` | `raw`).
- `GET /healthz` — `{ ok: true }`.

## Watchdog (scheduled read-only sessions)

Set `RHUMB_WATCHDOG_MINUTES=<n>` and the host runs a reconcile-and-report
session every *n* minutes: it syncs the ontology, checks every service's
status and health endpoint, compares hosts/containers/node placement against
the map, and files the report as a normal session titled `Watchdog — <stamp>`
(read it in the client's Sessions panel). Mutation is structurally impossible
in these sessions — `Bash`/`Write`/`Edit` and **all gated infra tools are
disallowed outright**, not gated, so a watchdog turn can never sit blocked in
the approval queue while nobody is watching. Unset the variable to turn the
watchdog off.

## Driving and approving over HTTP

In identity mode (the default), every control-plane request must arrive through
`tailscale serve` with a tailnet identity on the allowlist, AND carry the shell
header `Sec-Rhumb-Control: 1`. Browsers cannot set `Sec-*` headers, so surface
iframes can never approve their own writes; the Tauri client's Rust proxy sends
the header automatically. For scripting/debugging from a tailnet machine:

    # send a message (starts or continues a session)
    curl -s -X POST -H 'Sec-Rhumb-Control: 1' -H 'content-type: application/json' \
      -d '{"prompt":"hello"}' https://<your-box>.ts.net/agent/messages

    # list pending gated infra actions
    curl -s -H 'Sec-Rhumb-Control: 1' https://<your-box>.ts.net/agent/infra/pending

    # approve (or deny) one
    curl -s -X POST -H 'Sec-Rhumb-Control: 1' -H 'content-type: application/json' \
      -d '{"decision":"approve"}' https://<your-box>.ts.net/agent/infra/pending/<id>/resolve

`Authorization: Bearer <RHUMB_CONTROL_TOKEN>` is only checked in
`RHUMB_INSECURE_DEV=1` mode — against an identity-mode host it returns
`403 {"error":"shell only"}`.
