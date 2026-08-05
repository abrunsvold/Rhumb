import type { AgentBackend, AgentSpec, AgentRef } from "../backends/types.js";
import type { AgentEvent } from "../types.js";
import type { AgentRegistry, AgentRecord } from "../agents.js";
import { checkCaps, capBreachMessage, type FleetCaps } from "./caps.js";
import { deriveAgentStatus, type AgentStatus, type MngrLiveness } from "./status.js";
// The mngr backend's own terminal-finish-reason vocabulary and empty-answer
// sentinel. `src/fleet/status.ts` already imports `isTerminalFinishReason`
// from here, so this module follows the same precedent rather than
// re-deriving the concept — fleet ops are mngr-specific in P1 regardless
// (only `createFleetOps({ backend: mngr-backend, ... })` is ever wired up).
import { isTerminalFinishReason, EMPTY_COMPLETION_RESULT } from "../backends/mngr.js";

export interface FleetTask {
  prompt: string;
  /** mngr address suffix. Local-only in P1; the parameter exists so remote
   *  placement widens this without a signature change. */
  placement?: string;
}

export type SpawnOutcome = { ok: true; agentId: string } | { ok: false; error: string };

export interface SpawnContext {
  parentAgentId: string | null;
  depth: number;
}

export interface FleetOps {
  /** Fix round 1, I2: DISPATCH-ONLY. `spawn` resolves once every task's
   *  principal has been created and bound (`ensure`) and its prompt handoff
   *  to `send` has been STARTED — never once the agent has ANSWERED.
   *  `ok: true` means "dispatched", not "replied"; use `check`/`collect` to
   *  learn the outcome of the underlying turn. The real backend's `send`
   *  blocks for up to five minutes waiting on a terminal reply, and
   *  awaiting that per task — serially or even concurrently — would make a
   *  batch of any size hold `spawn` open for as long as its slowest member,
   *  defeating the reason `check`/`collect` exist and blowing any caller's
   *  timeout (e.g. an MCP tool call). */
  spawn(tasks: FleetTask[], ctx: SpawnContext): Promise<SpawnOutcome[]>;
  check(agentIds: string[]): Promise<Array<{ agentId: string; status: AgentStatus }>>;
  collect(
    agentIds: string[],
    waitMs?: number,
  ): Promise<Array<{ agentId: string; status: AgentStatus; result: string | null }>>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Minimal in-process mutex (fix round 1, C3). Serializes calls to `fn` so
 *  that the SECOND caller's synchronous prefix cannot even begin running
 *  until the FIRST caller's `fn` has fully settled (resolved or rejected).
 *
 *  This exists to close a TOCTOU race in `spawn`'s cap check: `checkCaps`
 *  is fed `await liveCount()`, and `liveCount()` itself awaits `liveness()`
 *  — a genuine suspension point. Without serialization, two concurrent
 *  `spawn` calls both resume from that suspension having read the exact
 *  same PRE-MUTATION `registry.list()` snapshot (taken synchronously,
 *  before either has called `registry.create`), both pass `checkCaps`
 *  individually, and both mint — jointly exceeding `maxConcurrent` even
 *  though neither breached it alone. Not hypothetical: models routinely
 *  emit parallel tool calls, and a later task wires this straight to a
 *  tool handler.
 *
 *  A single Node process is single-threaded (no real parallelism to
 *  coordinate across), so a plain promise chain is sufficient — no
 *  cross-process lock, file lock, or timeout is needed. `fn` is chained
 *  onto the tail as BOTH the fulfillment and rejection handler so one
 *  caller's exception (e.g. a cap breach) never wedges the queue for
 *  everyone after it. */
function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    // The tail must always resolve (never reject) so a rejected `fn` still
    // releases the lock for the next queued caller; `result` (returned
    // below) still carries the real rejection back to ITS caller.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function createFleetOps(deps: {
  backend: AgentBackend;
  registry: AgentRegistry;
  caps: FleetCaps;
  spec: AgentSpec;
  mintName: () => string;
  /** nativeId -> liveness, from `mngr list --format json`. A null return means
   *  UNKNOWABLE, never "nothing is live". */
  liveness: () => Promise<Map<string, MngrLiveness> | null>;
  /** The last assistant finish_reason for one agent, or null if unreadable. */
  lastFinishReason: (nativeId: string) => Promise<string | null>;
  pollIntervalMs?: number;
}): FleetOps {
  const { backend, registry, caps, spec, mintName, liveness, lastFinishReason } = deps;
  const pollInterval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const withMutex = createMutex();

  /** How many mngr-backed principals currently consume a concurrency slot
   *  (fix round 1, I1). Nothing in the registry ever flips a record's
   *  `status` back from "active" once an agent finishes its work — `bind`/
   *  `touch` don't, and `markStopped` is only ever called through an
   *  explicit `stop()`. Before this fix, `liveCount` was simply
   *  `registry.list().filter(active mngr records).length`, which meant
   *  every mngr agent EVER spawned counted forever, including agents from
   *  a previous process lifetime (the index persists on disk) and any
   *  non-fleet mngr session. With the default cap of 8 that bricks the
   *  fleet permanently after the 9th spawn ever attempted on a box — a
   *  certainty, not a risk, since the cap fails closed.
   *
   *  Fixed by reconciling against actual mngr liveness rather than trusting
   *  the registry's "active" flag at face value:
   *   - A record with NO nativeId yet is a principal THIS process just
   *     minted (inside `spawn`'s mutex-guarded region, before `ensure` has
   *     run) or one whose `ensure` could not yet be confirmed. It is not a
   *     proven live process, but it IS a real capacity commitment this
   *     process just made, and `registry.create` is synchronous — so
   *     counting it is what keeps the C3 mutex meaningful at all. Excluding
   *     it would let two mutex-serialized `spawn` batches both read
   *     "0 live" for the second batch's check, since the first batch's
   *     brand-new records would still show `nativeId === null` at that
   *     point (they haven't been through `ensure` yet, which runs OUTSIDE
   *     the mutex — see `spawn`).
   *   - A record WITH a nativeId is reconciled against `liveness()`, but
   *     ONLY excluded from the count when it is POSITIVELY confirmed
   *     terminal — `deriveAgentStatus` says "done" or "stopped" for a
   *     PRESENT map entry. Every other case counts, including a nativeId
   *     that is simply ABSENT from the listing. Absence is ambiguous — it
   *     could mean "mngr has genuinely forgotten this agent" (safe to
   *     exclude) or "the listing hasn't caught up with a create that just
   *     happened a moment ago" (NOT safe to exclude: this is the same
   *     just-ensured-but-not-yet-listed window the null-`nativeId` case
   *     above handles for the pre-`ensure` moment, just one step later). A
   *     `deriveAgentStatus` call against a missing entry would collapse to
   *     "unknown" the same way a positively-dead agent's stale/malformed
   *     entry would, and those two must not be treated alike here — so
   *     "absent" is handled explicitly, before consulting
   *     `deriveAgentStatus` at all, rather than by feeding it
   *     `live.get(id) ?? null` (which conflates "absent" with "explicitly
   *     unknowable").
   *   - `lastAssistantFinishReason` is passed as `null` for a present entry
   *     (this is a capacity check, not a `check()`/`collect()` call —
   *     fetching it per record would mean extra work just to bias a
   *     WAITING/END_OF_TURN record toward "done" a little more often).
   *     `null` biases `deriveAgentStatus` toward "working" in that branch —
   *     the safe direction, since it can only make `liveCount` an
   *     OVER-estimate, never an under-estimate: the failure mode of this
   *     approximation is a wrongly-REJECTED spawn, never a wrongly-ADMITTED
   *     one past the cap.
   *   - If `liveness()` itself is unknowable (`null`), fall back to
   *     trusting the registry's "active" count outright — same
   *     never-undercount rationale, and the same discipline
   *     `deriveAgentStatus`/`statusFor` already apply to a null liveness
   *     snapshot. */
  async function liveCount(): Promise<number> {
    const active = registry.list().filter((r) => r.backend === "mngr" && r.status === "active");
    const live = await liveness();
    if (live === null) return active.length;

    let count = 0;
    for (const rec of active) {
      if (!rec.nativeId) {
        count++;
        continue;
      }
      if (!live.has(rec.nativeId)) {
        count++; // absent, not confirmed dead — see doc comment above.
        continue;
      }
      const status = deriveAgentStatus({
        liveness: live.get(rec.nativeId) ?? null,
        lastAssistantFinishReason: null,
      });
      if (status !== "done" && status !== "stopped") count++;
    }
    return count;
  }

  async function statusFor(agentId: string): Promise<AgentStatus> {
    const rec = registry.get(agentId);
    if (!rec) return "unknown";
    if (rec.status === "stopped") {
      // Fix round 1, I3: a stopped (killed, or intentionally retired)
      // principal is neither "done" nor equivalent to one — "done" implies
      // the model completed normally and left an answer worth collecting.
      // `AgentStatus` already has "stopped" for exactly this case; this
      // path never returned it before this fix, so a killed/failed agent
      // was reported as successfully completed, transcript excerpt and
      // all.
      return "stopped";
    }
    if (!rec.nativeId) return "working";
    const live = await liveness();
    if (live === null) return "unknown";
    return deriveAgentStatus({
      liveness: live.get(rec.nativeId) ?? null,
      lastAssistantFinishReason: await lastFinishReason(rec.nativeId),
    });
  }

  /** The final answer text for one agent, or `null` when there isn't one to
   *  report (fix round 1, I4 + I5).
   *
   *  I4: `collect` used to take the transcript's LAST `kind: "text"` entry
   *  unconditionally. An agent whose last assistant message is `tool_use`
   *  narration (mid-turn, about to call a tool) would have that narration
   *  reported as its "final answer" — exactly the bug `send()`'s own
   *  terminal-`finish_reason` selection exists to prevent, reopened here by
   *  bypassing it. The public `transcript()` deliberately strips
   *  `finishReason` from each entry (it is not part of the client-facing
   *  `TranscriptMessage` shape), so terminality can't be read off the
   *  transcript entry itself; `lastFinishReason(nativeId)` (already
   *  injected for `statusFor`) is asked instead. Only when it reports a
   *  TERMINAL reason is the transcript's last text entry trusted as the
   *  answer.
   *
   *  I5: `result: null` used to conflate three different situations —
   *  "finished with genuinely nothing to say", "transcript unreadable",
   *  and "not done yet" / "principal never bound". The mngr backend already
   *  has a convention for the first case (`EMPTY_COMPLETION_RESULT`,
   *  reused here rather than re-invented) precisely because "finished with
   *  nothing to say" and "still working" must not look alike. `null` stays
   *  reserved for the other cases the fixed `result: string | null` shape
   *  cannot further distinguish (documented below and in the report). */
  async function resultFor(agentId: string, status: AgentStatus): Promise<string | null> {
    if (status !== "done") return null;

    const rec = registry.get(agentId);
    if (!rec?.nativeId) return null; // unbound principal: nothing to read.

    const msgs = await backend.transcript({ agentId, nativeId: rec.nativeId, backend: "mngr" });
    if (msgs === null) return null; // unreadable transcript — indistinguishable
    // from "not done" under the fixed `string | null` result shape; see I5
    // note above and the report.

    const last = msgs.filter((m) => m.kind === "text").at(-1) ?? null;
    if (!last) return EMPTY_COMPLETION_RESULT;

    const finishReason = await lastFinishReason(rec.nativeId);
    if (!isTerminalFinishReason(finishReason)) return null; // I4: mid-turn
    // narration, not a real answer — withhold it rather than report it.

    return last.text.trim().length > 0 ? last.text : EMPTY_COMPLETION_RESULT;
  }

  /** A task failed AFTER `ensure` produced a real, bound agent — i.e. a live
   *  mngr process genuinely exists (fix round 1, C2). Before this fix, a
   *  failure here was recorded by editing the registry's JSON `status`
   *  field alone (`registry.markStopped`), which does nothing to the real
   *  mngr agent: it keeps running in tmux, orphaned — a real process on the
   *  box, costing real money, that nobody sanctioned. Worse, marking the
   *  record stopped ALSO makes it unrecoverable: `ensureAgent` refuses to
   *  silently revive a stopped principal by design, and `list()` filters
   *  out stopped records, so the leaked agent becomes invisible to the
   *  operator with no handle left to find or stop it.
   *
   *  Fixed by stopping the REAL agent first, and only marking the registry
   *  record stopped once that succeeds. If `stop` itself fails, the record
   *  is deliberately left ACTIVE (not stopped) — the agent stays
   *  discoverable via `list()`/`check()` for a later retry, and the stop
   *  failure is folded into the reported error instead of being swallowed. */
  async function failAfterEnsure(agentId: string, ref: AgentRef, primaryError: string): Promise<void> {
    try {
      await backend.stop(ref);
      registry.markStopped(agentId);
    } catch (e) {
      const stopMsg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[rhumb] fleet: agent ${agentId} failed (${primaryError}) and could not be stopped either ` +
          `(${stopMsg}); left ACTIVE and discoverable via list()/check() for manual cleanup rather than ` +
          "marked stopped, which would have hidden a still-live leaked agent with no handle left to find it.",
      );
    }
  }

  /** Fires `send` for an already-ensured agent WITHOUT awaiting it (I2 —
   *  see `spawn`'s doc comment for why). `send`'s only error channel is the
   *  `onEvent` callback (fix round 1, C1: the real mngr backend's `send`
   *  resolves NORMALLY even on failure — an unbindable principal, a
   *  non-zero `mngr message` exit, a delivered-but-unanswered turn — it
   *  reports failure by calling `onEvent({type:"error", ...})`, never by
   *  throwing). The brief's original `() => {}` discarded every one of
   *  those events, so every mngr-side failure was silently reported as
   *  `ok: true`. This collects them and, on failure, runs the real
   *  `failAfterEnsure` stop-then-mark-stopped sequence — asynchronously,
   *  since by the time any of this resolves `spawn` has already returned.
   *  `.catch()` on the whole chain guarantees no unhandled rejection
   *  escapes this fire-and-forget call, matching the AgentBackend contract
   *  defensively even though the real backend's `send` never rejects. */
  function dispatchSend(agentId: string, ref: AgentRef, prompt: string): void {
    const events: AgentEvent[] = [];
    backend
      .send(ref, prompt, (e) => events.push(e))
      .then((finalRef) => {
        const errorEvent = events.find((e) => e.type === "error");
        if (errorEvent) {
          return failAfterEnsure(agentId, finalRef, (errorEvent as { message: string }).message);
        }
        return undefined;
      })
      .catch((e) => failAfterEnsure(agentId, ref, e instanceof Error ? e.message : String(e)))
      .catch((e) => {
        // failAfterEnsure itself should never throw, but this is a
        // fire-and-forget chain — guarantee nothing unhandled escapes it
        // regardless.
        console.warn(`[rhumb] fleet: could not record a dispatch failure for ${agentId}:`, e);
      });
  }

  /** One task's dispatch: `ensure` is AWAITED (fast — create/bind, and its
   *  result is what `SpawnOutcome` reflects, per C1), then `send` is
   *  started but not waited on (I2). */
  async function dispatchOne(task: FleetTask, rec: AgentRecord): Promise<SpawnOutcome> {
    type MaybeUnensuredRef = AgentRef & { reason?: unknown };
    let ref: MaybeUnensuredRef;
    try {
      ref = (await backend.ensure(rec.agentId, spec)) as MaybeUnensuredRef;
    } catch (e) {
      // Defensive: the real mngr backend's `ensure` never throws (failure
      // is always a null `nativeId` — see below), but nothing in the
      // `AgentBackend` type guarantees that of every implementation.
      return { ok: false, error: `agentId ${rec.agentId}: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (!ref.nativeId) {
      // C1: `ensure`'s ONLY failure channel is a null `nativeId` plus an
      // internal `reason` code (an unbindable principal, an invalid name, a
      // create that couldn't be confirmed, a stopped principal refusing
      // revival, ...) — never a thrown exception. Reporting `ok: true` here
      // told the model N agents launched when some never existed at all;
      // the unbound record would then read "working" forever and `collect`
      // would poll a phantom out to its deadline on every call.
      //
      // No real process is known to exist for this principal (or its
      // existence is merely unconfirmed), so nothing is stopped here —
      // unlike `failAfterEnsure`, this does NOT call `registry.markStopped`.
      // Doing so would make the principal permanently unrecoverable
      // (`ensureAgent` refuses to silently revive a stopped principal), and
      // some of these reasons (e.g. "create-unconfirmed") are exactly the
      // case where a LATER `ensure` call on the same agentId is expected to
      // self-heal via mngr's resolve-before-create adoption. The record is
      // left active and unbound on purpose.
      const reason = typeof ref.reason === "string" ? ref.reason : "unensured";
      return { ok: false, error: `agentId ${rec.agentId}: mngr: agent could not be ensured (${reason})` };
    }

    dispatchSend(rec.agentId, ref, task.prompt);
    return { ok: true, agentId: rec.agentId };
  }

  return {
    async spawn(tasks, ctx) {
      // Caps first: a breach rejects the WHOLE batch before any principal is
      // minted or any agent created. Partial application of a rejected spawn
      // would leave orphans the operator never approved — real processes on
      // the box, costing real money, that nobody sanctioned.
      //
      // C3: the check AND every `registry.create` call for this batch run
      // inside `withMutex`, so a concurrently-running `spawn` cannot observe
      // a stale (pre-mutation) `liveCount`. See `createMutex`'s doc comment
      // for the exact race this closes.
      const created = await withMutex(async () => {
        const breach = checkCaps({
          caps,
          requested: tasks.length,
          liveCount: await liveCount(),
          depth: ctx.depth,
        });
        if (breach) throw new Error(capBreachMessage(breach));

        return tasks.map((task) => ({
          task,
          rec: registry.create(mintName(), "mngr", {
            parentAgentId: ctx.parentAgentId,
            depth: ctx.depth + 1,
          }),
        }));
      });

      // I2: dispatch-only and concurrent — see `FleetOps.spawn`'s doc
      // comment. This runs OUTSIDE the mutex on purpose: a slow `ensure`
      // (real `mngr create` calls) must not block a DIFFERENT batch's cap
      // check, only the check-then-mint region itself needs to be atomic.
      return Promise.all(created.map(({ task, rec }) => dispatchOne(task, rec)));
    },

    async check(agentIds) {
      const out: Array<{ agentId: string; status: AgentStatus }> = [];
      for (const agentId of agentIds) out.push({ agentId, status: await statusFor(agentId) });
      return out;
    },

    async collect(agentIds, waitMs = 0) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const statuses = await Promise.all(agentIds.map(async (a) => ({ agentId: a, status: await statusFor(a) })));
        // Settlement check: "working" clearly means "not done yet, keep
        // polling". "blocked" (mngr WAITING/PERMISSIONS — a tool-approval
        // dialog) is deliberately treated as SETTLED here, not as
        // unsettled alongside "working". A blocked agent will never
        // self-resolve without an operator acting on the approval dialog,
        // so busy-polling it until `waitMs` elapses just burns the wait
        // budget on a status that cannot change within this call. Callers
        // get "blocked" back immediately (with result: null, since
        // `resultFor` only ever produces a result for "done"), which is
        // the actionable signal — poll again later, after prompting a
        // human, rather than have `collect` sit there hoping.
        const settled = statuses.every((s) => s.status !== "working");
        if (settled || Date.now() >= deadline) {
          return Promise.all(
            statuses.map(async (s) => ({
              agentId: s.agentId,
              status: s.status,
              result: await resultFor(s.agentId, s.status),
            })),
          );
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    },
  };
}
