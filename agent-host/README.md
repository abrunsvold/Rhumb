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
> apply to them. (Gateway mode enforces that: `ANTHROPIC_AUTH_TOKEN` is required —
> `none` for an auth-free gateway — because with it empty the CLI would fall back
> to a stored claude.ai login and send it to the gateway.) See [COMPLIANCE.md](../COMPLIANCE.md) for the full reasoning.

## Run

    npm install
    npm run build
    CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start   # or the api-key / gateway vars above

Environment variables: `RHUMB_LLM_PROVIDER` (default `subscription`) plus that
mode's credentials — `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`, or
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (required in gateway mode; set it
to `none` for an auth-free gateway — an empty value is refused because the CLI
would otherwise fall back to a stored claude.ai login and send it to the
gateway); `RHUMB_PORT` (default
8787), `RHUMB_MODEL` (default `claude-opus-4-8`; required in gateway mode),
`RHUMB_WORKSPACE` (default `./workspace`), `RHUMB_PERMISSION_MODE` (default
`acceptEdits`), `RHUMB_ALLOWED_USERS` (comma-separated tailnet logins, e.g.
`alice@github`; **required** in the default identity mode — the host refuses to
start without it), `RHUMB_INSECURE_DEV` (set to `1` to skip the identity
allowlist and loopback-only bind; **local development only**, never on a box
reachable by anyone else); `RHUMB_AGENT_BACKEND` (default `sdk`; see
[Agent execution backend](#agent-execution-backend) below).

### Agent execution backend

`RHUMB_AGENT_BACKEND` selects how agents run. Default: `sdk`.

| Value | Behavior |
| --- | --- |
| `sdk` | Claude Code in-process via the Agent SDK. One agent, one workspace. The behavior Rhumb has always had. |
| `mngr` | **EXPERIMENTAL.** Agents are spawned through the [mngr](https://github.com/imbue-ai/mngr) CLI. Localhost only. See the limitations below before switching. |

#### `mngr` mode is EXPERIMENTAL

It is not a drop-in peer of `sdk`. What is *not* wired yet:

- **No incremental streaming.** A turn emits one `session` event and then a
  single terminal event (`result` or `error`) — nothing in between. The SSE
  stream shows no tool calls, no partial text, no progress. `mngr` does have a
  streaming channel (`mngr event <name> --follow`), but Rhumb does not consume
  it; `send()` polls `mngr transcript --format jsonl` for the reply instead.
- **A turn can end "delivered but not yet answered."** `mngr message` returns on
  *submission*, not completion, so Rhumb waits for the reply to appear in the
  transcript. If nothing appears within five minutes the turn ends with an
  honest error rather than a fabricated answer. Against mngr 0.2.17 `mngr
  message` routinely exits non-zero after a 90-second internal timeout on turns
  that were in fact delivered and answered within seconds; Rhumb reconciles
  against the transcript rather than trusting that exit code, so those turns
  still return the model's real reply.
- **No operator handle to list or stop agents.** `list()`, `stop()`, and
  `transcript()` exist on the backend but have no production callers — no HTTP
  route, no client affordance. Nothing in `src/` ever calls `stop()`. In
  practice a mngr agent is created and then lives until you run `mngr destroy`
  yourself.
- **Workspace:** agents run **in place** in `RHUMB_WORKSPACE` — see below.

`mngr` mode requires `mngr`, `tmux`, `git`, `jq`, and bash 4+ on `PATH`. The host
checks eagerly at startup and refuses to boot without them, rather than failing
on your first turn (macOS ships bash 3.2, which fails silently — see
`assertMngrPrerequisites` in `src/backends/exec.ts` for why bash 4+ is checked
too):

    brew install tmux git jq bash
    uv tool install imbue-mngr --with imbue-mngr-claude

**Identity.** Rhumb mints and owns the durable agent principal (`agentId`),
recorded in `workspace/agents.json`. A mngr agent id is stored alongside it as
`nativeId` — a runtime binding only. mngr ids are plaintext and settable via
`mngr create --id`, so Rhumb treats them as identifiers, never as credentials.
Because a mngr fork mints a fresh id, a forked agent inherits nothing from its
parent.

**Adoption.** Every agent Rhumb creates through mngr is stamped with a
`rhumb_agent_id` label at creation time. Rhumb only ever adopts an existing
mngr agent by matching that label against the calling principal's own
`agentId` — never by name, and never by trusting `mngr create`'s own stdout.
This is what keeps adoption fail-closed: an agent a human created directly, or
one another tool made, never carries the label, so it can never be adopted —
only an agent Rhumb itself created (and therefore already credential-scrubbed,
below) can ever match.

**Workspace.** A mngr agent runs **in place** in `RHUMB_WORKSPACE`, so it sees
the same data-sources, surfaces, ontology, and uploaded files the host does, and
its writes land where the host reads them. Rhumb passes
`--from :<workspace> --transfer none --no-ensure-clean` to `mngr create` to get
this. Consequences worth knowing:

- mngr's default is to fork a **git worktree** on a new `mngr/<name>` branch.
  Rhumb deliberately does not use that: the workspace is shared mutable state,
  not a branch. No branch or worktree is created for a Rhumb agent, and nothing
  is left behind in any repo.
- Because the agent runs directly in the workspace, **every mngr agent shares
  one directory**. There is no per-agent isolation in this release.
- If `RHUMB_WORKSPACE` happens to sit inside a git repo, a dirty tree is fine —
  `--no-ensure-clean` is passed, because `workspace/` is *expected* to be dirty
  (it is where agents write). Without it, any uncommitted file would fail every
  turn.
- The path is resolved to an absolute path before being handed to mngr, so it
  never depends on the host process's working directory. The backend refuses to
  start at all if the workspace is blank.

**Credentials.** In `mngr` mode the spawned agent receives exactly the
credential variables Rhumb chose **at spawn time** and nothing from the ambient
environment. This matters more here than it sounds: mngr does **not** scrub the
environment it hands a spawned agent by default — a spawned agent's env comes
from whatever the mngr tmux server was originally started with, not from the
environment of whichever process asked mngr to create it. Rhumb closes that
gap by passing an explicit `--env` override for every credential variable on
every `mngr create` call — the selected provider's values as given, and every
other credential variable blanked — which overrides the tmux server's
inherited environment regardless of what it originally started with.

> **Credentials are frozen at spawn (limitation).** `--env` is applied only at
> `mngr create`. An agent adopted by its `rhumb_agent_id` label on a later turn
> keeps whatever credential was injected when it was first spawned — across
> agent-host restarts, token rotation, and provider switches. This is **weaker
> than the SDK path**, which rebuilds `sanitizedEnv` on every turn and therefore
> always uses the current credential. To make a rotated token or a changed
> `RHUMB_LLM_PROVIDER` reach an existing mngr agent you must destroy and
> recreate it (`mngr destroy <name> --force -b`).

> **Changing any `RHUMB_*` variable requires `tmux kill-server`.** The SDK path
> strips every `RHUMB_*` variable with a wildcard scan. The mngr path reproduces
> that by enumerating the `RHUMB_*` keys of the **agent-host process's** own
> environment and blanking each one via `--env`. But spawned agents inherit from
> the **tmux server's** environment, which can predate the current agent-host
> process. So after adding, removing, or changing a `RHUMB_*` variable,
> restarting agent-host alone is **not** enough — run `tmux kill-server` so the
> next `mngr create` starts a fresh server under the new environment. (Phase 0
> hit exactly this: a stale tmux server silently made a credential-leak test
> measure nothing.)

> **Blank vs. absent (known divergence).** `env.ts` **deletes**
> `STRIPPED_ENV_VARS` for the SDK path; the mngr path can only set them to the
> empty string, since `--env VAR=` is the only way to override an inherited
> value. So `CLAUDE_CONFIG_DIR=""` (and the other stripped variables) are
> *present but empty* on every mngr agent, rather than absent. Empirically
> tolerated by Claude Code CLI 2.1.196, but the two paths are not byte-identical
> here.

**Capability reduction, not a gate bypass.** A mngr agent does not receive
Rhumb's in-process MCP servers (infra, ontology) or the operator-approval
callback (`canUseTool`) — there is no CLI equivalent for a live JS closure or
an in-process approval promise, only for external, file-based MCP config. The
host warns about this once at startup rather than refusing to boot, because
dropping them makes the agent strictly *less* capable, not less gated: the
tools `canUseTool` protects are served *by* the dropped MCP servers, so with
those servers gone there is nothing left for the gate to protect, and the
same `RHUMB_*` credential blanking described above means the agent cannot
reach infra through Bash as a substitute either.

#### Running the live mngr test suite

`test/backend-mngr.integration.test.ts` drives real `mngr`, real `tmux`, and
real `claude` processes. It is **opt-in** and does not run under `npm test`:

    RHUMB_LIVE_MNGR=1 npx vitest run test/backend-mngr.integration.test.ts

Both `RHUMB_LIVE_MNGR=1` **and** the `mngr`/`tmux`/`git` binaries are required;
with the variable unset the suite reports as skipped. Two reasons it is gated
rather than keyed on binary presence alone:

- **It runs `tmux kill-server`,** which kills *all* of your tmux sessions, not
  just mngr's. That call is mandatory for the suite's most valuable assertion
  (that an ambient credential never reaches a spawned agent): a mngr agent's
  environment comes from whatever the tmux **server** was started with, so a
  server predating the test's decoy variables would make the test pass while
  proving nothing. Killing it first is what makes an absent decoy meaningful.
- **It takes several minutes** and creates real agents. Without the gate, `npm
  test` silently became a multi-minute, side-effecting run on any machine that
  happened to have mngr installed.

Set `CLAUDE_CODE_OAUTH_TOKEN` as well to additionally exercise a turn that
returns a real model reply; without it that one case reports as skipped.

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
