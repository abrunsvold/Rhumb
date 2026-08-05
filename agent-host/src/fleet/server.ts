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

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

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
          "no nested fleets). Requires operator approval before it runs.",
        {
          tasks: z
            .array(
              z.object({
                prompt: z.string(),
                placement: z.string().optional(),
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
          "Safe to call repeatedly while waiting for a fleet to finish.",
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
          "for agents still working to finish. Getting PARTIAL results back when the wait " +
          "expires is normal, not an error — agents still working come back with " +
          "status 'working' and a null result; call collect again later for those ids.",
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
