import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FleetOps, SpawnContext } from "./ops.js";

export const FLEET_TOOL_NAMES = [
  "mcp__fleet__spawn",
  "mcp__fleet__check",
  "mcp__fleet__collect",
] as const;

/** Only `spawn` mutates anything (it creates new agent principals), so only
 *  `spawn` is gated. `check`/`collect` are reads and must stay ungated —
 *  forcing an approval to poll would make the operator approve constantly
 *  and learn to click through, which is a worse security outcome than one
 *  well-presented decision on the action that actually matters. */
export const GATED_FLEET_TOOL_NAMES: ReadonlySet<string> = new Set(["mcp__fleet__spawn"]);

/** The fleet tools buildApp pre-allows on the SDK's `allowedTools` list —
 *  every fleet tool EXCEPT the gated ones. A pre-allowed tool is approved by
 *  the SDK without ever consulting `canUseTool`, so `spawn` must be absent:
 *  listing it here would silently remove the operator gate. Exported (rather
 *  than inlined at the registration site) so `test/fleet-server.test.ts` can
 *  pin the exclusion — deleting the filter goes red there. */
export function preAllowedFleetToolNames(): string[] {
  return FLEET_TOOL_NAMES.filter((n) => !GATED_FLEET_TOOL_NAMES.has(n));
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

/** THE BUILD LIMITATION, SAID ONCE, IN THE MODEL'S OWN TOOL DESCRIPTIONS
 *  (final review, I1).
 *
 *  `src/index.ts` wires `createFleetOps`'s `liveness`/`lastFinishReason` to
 *  `async () => null` — honest stubs, because real wiring hasn't landed. The
 *  consequence chain is exact and worth stating rather than discovering:
 *  `statusFor` (ops.ts) returns "unknown" for every bound agent, and
 *  `resultFor` short-circuits on `status !== "done"` — so `check` cannot
 *  report progress and `collect` cannot return a result, for any agent, ever,
 *  in this build.
 *
 *  Without this text the tool descriptions promised the opposite (`check`
 *  advertised the full status vocabulary; `collect` described returning real
 *  results), and the realistic first live run was: spawn a fleet, poll until
 *  the model concludes nothing is happening, give up — leaving real Claude
 *  Code processes running in tmux on the operator's box, unobserved and (see
 *  the spawn note below) with the concurrency cap permanently consumed. A
 *  model that is TOLD the tool is blind can say so to the operator on turn
 *  one instead.
 *
 *  Phrased as a CURRENT-BUILD limitation, never as the permanent contract:
 *  the tools stay registered and their real semantics stay documented, so
 *  when real liveness lands the edit is to delete these two constants and the
 *  current-build sentences that concatenate them into the descriptions below
 *  — the surrounding text is already correct for that day.
 *  `test/fleet-server.test.ts` asserts both descriptions carry the limitation,
 *  so the tools cannot quietly start over-promising again. */
const NO_LIVENESS_IN_THIS_BUILD =
  " *** LIMITATION OF THIS BUILD: agent liveness is not wired up yet, so this tool " +
  "CANNOT SEE the agents. Status comes back as \"unknown\" for every agent, always — it does " +
  "NOT mean the agent is broken, and polling will never change it. ";

const INSPECT_WITH_MNGR =
  "Spawned agents really do run and really do work; they just cannot be observed through this " +
  "tool in this build. Tell the operator to inspect them directly with the mngr CLI " +
  "(`mngr list`, `mngr transcript <name>`), and do not sit in a polling loop waiting for a " +
  "status that cannot arrive. ***";

/**
 * The `spawn` tool's zod schema intentionally accepts ONLY `tasks` — no
 * `depth`, no `parentAgentId`, not even as optional fields. `SpawnContext`
 * (parentAgentId/depth) is derived SERVER-SIDE by the `ctx` thunk the host
 * supplies and is never read from model-supplied tool arguments. If the
 * model could pass `depth: 0` on a spawn call, the depth cap in
 * `src/fleet/caps.ts` would be trivially evaded by simply claiming to be a
 * root agent. Do not widen this schema to accept either field — see
 * `test/fleet-server.test.ts`'s schema-shape assertion, which exists
 * specifically to catch a future edit that does.
 */
export function createFleetServer(ops: FleetOps, ctx: () => SpawnContext) {
  return createSdkMcpServer({
    name: "fleet",
    version: "1.0.0",
    tools: [
      tool(
        "spawn",
        "Spawn one background agent per task and return their agent ids. " +
          "Returns IMMEDIATELY once the agents are created — the agents are " +
          "still working when this call returns; it does NOT wait for them to " +
          "answer. Use check/collect afterward to find out when they finish " +
          "and what they produced. Each result entry is either {ok:true, agentId} " +
          "or {ok:false, error} — check ok per task, since some tasks in a batch " +
          "can fail to dispatch while others succeed. A spawned agent's own ability " +
          "to spawn further agents is subject to the operator's depth cap (default: " +
          "no nested fleets). Requires operator approval before it runs. " +
          // Final review, I1: the same current-build honesty the check/collect
          // descriptions carry, aimed at the decision the model makes BEFORE
          // spawning. Nothing retires a spawned agent's record, so every agent
          // ever spawned on a given `agents.json` counts against the
          // concurrency cap forever (ops.ts `liveCount` falls back to
          // `active.length` while `liveness` is stubbed). A model that spends
          // the cap on exploratory spawns bricks the fleet for the operator,
          // permanently, and cannot even observe what it spent it on.
          "*** LIMITATION OF THIS BUILD: spawned agents are never reaped. Each one you " +
          "create permanently consumes a slot of the operator's concurrency cap (default 8) " +
          "for the lifetime of this workspace — destroying the agent does not give the slot " +
          "back. The cap counts ALL of the operator's active mngr conversations, including " +
          "their own foreground (depth-0) ones — not just fleet-spawned agents — so fewer " +
          "slots may be free than your own spawns account for. And because check/collect " +
          "cannot observe agents in this build (see those " +
          "tools), you will not be able to tell what a spawned agent did. Spawn only what the " +
          "operator actually asked for; do not spend the cap exploring, and tell the operator " +
          "they will need to inspect the results with the mngr CLI themselves. ***",
        {
          tasks: z
            .array(
              z.object({
                prompt: z.string(),
                placement: z
                  .string()
                  .optional()
                  .describe(
                    "Where to run this agent. LOCAL ONLY in this release: omit it, or pass " +
                      '"local"/"localhost". Any other value is REJECTED for that task with ' +
                      "ok:false — the task is not spawned. There is no way to run a fleet agent " +
                      "on another machine in this release, so do not pass a hostname.",
                  ),
              }),
            )
            .describe(
              "One entry per agent to spawn. Give every task the same prompt to fan out over a list; " +
                "give each task a different prompt to run a work queue.",
            ),
        },
        async (args) => {
          try {
            return ok(JSON.stringify(await ops.spawn(args.tasks, ctx())));
          } catch (e) {
            // ops.spawn THROWS on a cap breach — zero principals created. That
            // must be unmistakable to the model, not just structurally distinct
            // (an error object vs. an array) inside an otherwise-successful
            // tool result — hence isError:true, matching the ontology/infra
            // server precedent (`fail()` in src/ontology/server.ts and
            // src/infra/server.ts), rather than `ok()` for this path.
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "check",
        "Cheap status check for previously spawned agents: working | done | blocked | stopped | failed | unknown. " +
          "Safe to call repeatedly while waiting for a fleet to finish." +
          NO_LIVENESS_IN_THIS_BUILD +
          INSPECT_WITH_MNGR,
        { agentIds: z.array(z.string()) },
        async (args) => {
          try {
            return ok(JSON.stringify(await ops.check(args.agentIds)));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "collect",
        "Fetch results from previously spawned agents. Optionally waits up to waitMs " +
          "for agents still working to finish (the host caps the honoured wait — 10 minutes " +
          "by default — so a larger waitMs is silently clamped, not an error). Getting " +
          "PARTIAL results back when the wait " +
          "expires is normal, not an error — agents still working come back with " +
          "status 'working' and a null result; call collect again later for those ids." +
          NO_LIVENESS_IN_THIS_BUILD +
          "Because the result is only ever produced for an agent whose status is \"done\", collect " +
          "returns NO RESULTS AT ALL in this build — every entry comes back with status " +
          "\"unknown\" and result null, and waiting longer cannot change that. " +
          INSPECT_WITH_MNGR,
        { agentIds: z.array(z.string()), waitMs: z.number().optional() },
        async (args) => {
          try {
            return ok(JSON.stringify(await ops.collect(args.agentIds, args.waitMs)));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
}
