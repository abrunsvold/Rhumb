import type { AgentBackend, AgentSpec } from "../backends/types.js";
import type { AgentRegistry } from "../agents.js";
import { checkCaps, capBreachMessage, type FleetCaps } from "./caps.js";
import { deriveAgentStatus, type AgentStatus, type MngrLiveness } from "./status.js";

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
  spawn(tasks: FleetTask[], ctx: SpawnContext): Promise<SpawnOutcome[]>;
  check(agentIds: string[]): Promise<Array<{ agentId: string; status: AgentStatus }>>;
  collect(
    agentIds: string[],
    waitMs?: number,
  ): Promise<Array<{ agentId: string; status: AgentStatus; result: string | null }>>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

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

  async function liveCount(): Promise<number> {
    return registry.list().filter((r) => r.backend === "mngr" && r.status === "active").length;
  }

  async function statusFor(agentId: string): Promise<AgentStatus> {
    const rec = registry.get(agentId);
    if (!rec) return "unknown";
    if (rec.status === "stopped") return "done";
    if (!rec.nativeId) return "working";
    const live = await liveness();
    if (live === null) return "unknown";
    return deriveAgentStatus({
      liveness: live.get(rec.nativeId) ?? null,
      lastAssistantFinishReason: await lastFinishReason(rec.nativeId),
    });
  }

  return {
    async spawn(tasks, ctx) {
      // Caps first: a breach rejects the WHOLE batch before any principal is
      // minted or any agent created. Partial application of a rejected spawn
      // would leave orphans the operator never approved — real processes on
      // the box, costing real money, that nobody sanctioned.
      const breach = checkCaps({
        caps,
        requested: tasks.length,
        liveCount: await liveCount(),
        depth: ctx.depth,
      });
      if (breach) throw new Error(capBreachMessage(breach));

      const outcomes: SpawnOutcome[] = [];
      for (const task of tasks) {
        const rec = registry.create(mintName(), "mngr", {
          parentAgentId: ctx.parentAgentId,
          depth: ctx.depth + 1,
        });
        try {
          const ref = await backend.ensure(rec.agentId, spec);
          await backend.send(ref, task.prompt, () => {});
          outcomes.push({ ok: true, agentId: rec.agentId });
        } catch (e) {
          registry.markStopped(rec.agentId);
          outcomes.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return outcomes;
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
        // `statusFor` only special-cases "done" for a result), which is
        // the actionable signal — poll again later, after prompting a
        // human, rather than have `collect` sit there hoping.
        const settled = statuses.every((s) => s.status !== "working");
        if (settled || Date.now() >= deadline) {
          return Promise.all(
            statuses.map(async (s) => {
              const rec = registry.get(s.agentId);
              const msgs = rec?.nativeId
                ? await backend.transcript({ agentId: s.agentId, nativeId: rec.nativeId, backend: "mngr" })
                : null;
              const last = msgs?.filter((m) => m.kind === "text").at(-1) ?? null;
              return { agentId: s.agentId, status: s.status, result: s.status === "done" ? (last?.text ?? null) : null };
            }),
          );
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    },
  };
}
