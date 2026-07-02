# Rhumb Agent Host

Server-side component of Rhumb. Wraps Claude Code (via the Claude Agent SDK) and
exposes a small HTTP + SSE session API over your Tailscale network.

## Authentication — personal-tool framing

Rhumb authenticates Claude with **your own Claude subscription**, not an API key.
Generate a long-lived token once:

    claude setup-token

Then export it before starting the host:

    export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`

> **Compliance note.** Anthropic's terms state that, without prior approval,
> third-party developers may not *offer* claude.ai login or rate limits in their
> products — including agents built on the Claude Agent SDK. Rhumb is a
> **self-hosted personal tool**: you run it on your own hardware with your own
> credentials. It does not broker, proxy, or offer Claude login to anyone else.
> If you want to distribute a multi-tenant or hosted offering, seek Anthropic's
> approval first.

## Run

    npm install
    npm run build
    CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start

Environment variables: `CLAUDE_CODE_OAUTH_TOKEN` (required), `RHUMB_PORT`
(default 8787), `RHUMB_MODEL` (default `claude-opus-4-8`), `RHUMB_WORKSPACE`
(default `./workspace`), `RHUMB_PERMISSION_MODE` (default `acceptEdits`),
`RHUMB_ALLOWED_USERS` (comma-separated tailnet logins, e.g. `alice@github`;
**required** in the default identity mode — the host refuses to start without
it), `RHUMB_INSECURE_DEV` (set to `1` to skip the identity allowlist and
loopback-only bind; **local development only**, never on a box reachable by
anyone else).

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
