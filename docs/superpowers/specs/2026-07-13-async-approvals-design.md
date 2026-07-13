# Async approvals — proposals that survive the turn

**Date:** 2026-07-13
**Status:** approved
**Prior art:** watchdog spec (slice 1; gated tools disallowed because a gated call blocks forever unattended), infra gate (`makeCanUseTool` + in-memory `PendingActions`), F22/F23 trust sharpening (approval-vs-trust audit provenance).

## Problem

The confirmation gate assumes an operator is watching: `canUseTool` blocks the
tool call on an in-memory promise until someone clicks. That design forced
slice 1's watchdog to disallow gated tools entirely — it can *see* the dead
poller but can't even propose the fix. And the queue itself dies with the
process: a restart silently discards every pending action.

## Decision (user-approved)

Gated actions become **proposals that survive the turn and the process**,
executed only on operator approval:

1. **Durable queue.** `PendingActions` persists to `<workspace>/pending-actions.json`
   (atomic writes). Entries gain `mode: "blocking" | "parked"`,
   `status: "pending" | "approved" | "denied" | "executed" | "failed" | "expired"`,
   `proposedBy: "interactive" | "watchdog"`, `resolvedAt?`, `result?`, `error?`.
   On boot: parked+pending entries reload and stay approvable; blocking+pending
   entries are marked `expired` (their turn died with the process — a promise
   cannot be resurrected); parked+approved entries whose execution was
   interrupted are marked `failed` ("host restarted during execution") — never
   silently re-executed.
2. **Two gate flavors, one queue.** Interactive sessions keep today's blocking
   gate unchanged. Scheduled sessions get a **parking** gate: the gated call
   enqueues (`mode: "parked"`) and immediately returns
   `deny` + "queued as <id> for operator approval — do not retry; note the
   proposal in your report". The turn completes; nothing hangs.
3. **Execute on approve.** The tool handlers' cores are extracted into
   `createGatedExecutor(deps).execute(tool, input) → string` (preserving each
   tool's exact behavior incl. which ops fire `onMutate`); the MCP handlers
   delegate to it. When the operator approves a parked entry, the infra router
   responds immediately and execution runs in the background: executor →
   outcome recorded on the entry (`executed`/`failed` + result/error, emitted
   as new stream events) → audit (`approved`, then `executed`/`error`).
   Denied parked entries just record `denied`.
4. **The watchdog proposes.** Its disallow list keeps `Bash`/`Write`/`Edit`/
   `NotebookEdit`/`AskUserQuestion` **and both destroy tools**
   (`destroy_vm`, `destroy_service` — the watchdog can never even *propose*
   destruction; structural, not prompt-level). The remaining gated tools flow
   through the parking gate with `proposedBy: "watchdog"`. Prompt addition:
   propose a one-step remediation per problem (e.g. `start_service` for a
   stopped service, `redeploy_service` for a crash-looper), note each queued
   proposal id in the report, never retry.
5. **Client = the inbox it already is.** The pending stream replays the queue
   on connect, so parked proposals appear in the ConfirmationDialog whenever
   the client opens. Additions: show "proposed by watchdog" on parked items
   (`proposedBy` threaded through the stream payload); `executed`/`failed`
   events are already ignored gracefully by the reducer's unknown-event
   fallthrough (old clients unaffected), and the new client keeps that
   behavior for now — outcome display is a later nicety.

## Invariant (unchanged trust bar)

**Nothing executes without explicit operator approval.** Parking moves the
*waiting* out of the turn, not the decision out of the human. Audit
provenance: parked flow logs `parked` at enqueue, `approved`/`denied` at
resolution, `executed`/`error` at completion — a parked action's execution is
always attributable to an approval.

## Out of scope

- Dashboard-host data-write queue persistence (same pattern, different host,
  user-driven traffic — separate change).
- Push notifications / unread inbox badges (slice 3).
- Approval TTLs / auto-expiry of stale proposals (revisit with real usage).
- Client outcome history UI.

## Testing

- `pending.test.ts`: mode/status lifecycle; persistence round-trip; boot
  expiry rules (blocking→expired, parked pending→alive, parked
  approved-uncompleted→failed); listeners fire for executed/failed.
- `infra-executor.test.ts`: executor preserves per-tool behavior against fakes
  (incl. which tools fire onMutate) — and the MCP handlers still pass their
  existing gating/handler tests after delegation.
- `infra-gate.test.ts` (or existing server tests): parking gate returns
  immediately with deny+queued message, audits `parked`; blocking gate
  unchanged.
- Router: approve of a parked entry answers 200 immediately, then records
  executed/failed; deny records without executing; blocking resolve unchanged.
- `watchdog.test.ts`: disallow list keeps destroy tools + built-ins, drops the
  other gated tools; prompt mentions proposals.
- Client `pendingStore`/dialog: proposedBy rendered; unknown event kinds still
  ignored.
- Live dogfood (post-merge): client closed, `pct stop 105` → watchdog report
  proposes `start_service printer-poller` → open client → approve → poller
  healthy, audit shows parked→approved→executed.
