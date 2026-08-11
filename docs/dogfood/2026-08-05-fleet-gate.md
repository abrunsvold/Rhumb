# Fleet approval gate — live verification

**Date:** 2026-08-05
**Branch:** `claude/fleet-orchestration` (PR #46)
**Host:** macOS, mngr 0.2.17, `RHUMB_AGENT_BACKEND=sdk`, `RHUMB_FLEET_ENABLED=1`

Closes the one link in the fleet's safety envelope that had never been observed:
**does the Agent SDK actually route `mcp__fleet__spawn` through `canUseTool`?**
Every unit test mocks that boundary, and the final whole-branch review flagged it
as "the only unverified link in the gate," resting on the `mcp__infra__*`
precedent by inference.

It does. All four checks below ran against a real `agent-host` process driving a
real model turn and real mngr agents.

## 1. The gate fires

A prompt instructing the model to call `mcp__fleet__spawn` produced a pending
approval in ~8s:

```json
{
  "pendingId": "95456486-…",
  "tool": "mcp__fleet__spawn",
  "input": { "tasks": [ {"prompt": "say alpha"}, {"prompt": "say beta"} ] },
  "mode": "blocking",
  "proposedBy": "interactive"
}
```

Note **both tasks in a single entry** — one approval per batch, as designed. The
alternative (N dialogs for an N-way fan-out) is what trains an operator to click
through.

## 2. Denial blocks completely

Resolving that entry `deny` left:

- `mngr list` → **No agents found**
- no `agents.json` written — **zero principals minted**
- audit: `{"tool":"mcp__fleet__spawn","input":{"taskCount":2},"decision":"denied"}`

The audit records the task **count and decision, never the prompts**, as specced.

## 3. Approval spawns, with correct lineage

Under default caps, approving produced two real agents:

```
fleet-4e048426  labels.rhumb_agent_id=rhumb-f2a3f56b-…  rhumb_depth=1
fleet-495e33bd  labels.rhumb_agent_id=rhumb-8089efb0-…  rhumb_depth=1
```

and two distinct principals bound to two distinct mngr ids, both at `depth: 1`.
Audit:

```json
{"decision":"executed","result":{"spawned":["rhumb-8089efb0-…","rhumb-f2a3f56b-…"],"failed":0}}
```

`parentAgentId` is `null` — expected, not a defect. `foregroundAgentId` is only
assigned under `RHUMB_AGENT_BACKEND=mngr`, and on that path the fleet MCP server
cannot cross the CLI boundary; on the `sdk` path (used here) the conversation is
not a principal. Documented in `index.ts` and the README.

## 4. The cap is INDEPENDENT of approval — the most valuable result

With `RHUMB_FLEET_MAX_PER_SPAWN=1`, the operator **approved** a two-task batch
and the cap still refused it:

```json
{"input":{"taskCount":2},"decision":"approved"}
{"input":{"taskCount":2,"parentAgentId":null,"depth":0},
 "decision":"error","error":"fleet: 2 tasks requested, limit 1 per spawn"}
```

`mngr list` → No agents found; no principals minted.

Two properties this establishes that no unit test could:

1. **Approving does not waive the cap.** They are independent lines of defence,
   in that order, and a human clicking "approve" cannot exceed the host's limits.
2. **A breach rejects the whole batch before anything is created** — against real
   mngr, not the fake `exec` every prior cap test used. No partial application,
   no orphaned agents the operator never sanctioned.

The audit distinguishes the two events, so "the operator approved but the host
refused" is answerable from the log alone.

## Boot-time behaviour, also confirmed live

Both warnings added in the final fix wave fired verbatim:

```
[rhumb] WARNING: enabling the fleet installs a tool-permission callback (canUseTool)
on a host that had none. mcp__fleet__spawn now requires operator approval, but every
OTHER tool is answered 'allow' by that callback rather than by the SDK's own
permission-mode policy (RHUMB_PERMISSION_MODE=acceptEdits). Unset RHUMB_FLEET_ENABLED
to restore the previous behaviour.

[rhumb] fleet: model-directed spawning ENABLED (max 8/spawn, 8 concurrent, depth 1);
every spawn requires operator approval
```

The second line's claim is now backed by evidence rather than inference.

## Method note

Tests ran with `RHUMB_INSECURE_DEV=1` plus a random `RHUMB_CONTROL_TOKEN`, on a
throwaway workspace, with every agent destroyed afterwards (`--force -b`, which
also removes the `mngr/<name>` branch). The deny case was run **first**
deliberately: if the gate had not been wired, the failure mode is two unapproved
agents spawning, and it is better to discover that having asked for a denial.

## Incidental finding

**mngr persists each agent's environment to `~/.mngr/agents/<id>/env` in
plaintext.** Since Rhumb injects the model credential via `--env`, a surviving
agent state dir contains the operator's OAuth token on disk. Destroying agents
removes it, but an abandoned agent leaves a credential behind. Worth considering
before fleet agents are left running unattended.
