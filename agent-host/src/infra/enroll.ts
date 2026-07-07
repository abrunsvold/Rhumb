import { appendInfraAudit } from "./audit.js";
import type { TailscaleClient } from "./tailscale.js";

// Same node-id alphabet as C_Fusion's fleet/bridge/render_bridge.py — the
// id becomes a MagicDNS hostname (cfusion-{id}) and an MQTT topic segment.
const NODE_ID = /^[A-Za-z0-9._-]+$/;

// Structural subset of OntologyOps that enrollment needs (kept narrow so
// tests can pass a plain recording object).
export interface OntologyUpsert {
  upsert(node: { id: string; title: string; subtype?: string; props?: Record<string, string> }): unknown;
}

export interface EnrollDeps {
  tailscale: TailscaleClient;
  ontology: OntologyUpsert;
  auditPath: string;
  now: () => string;
}

export interface EnrollResult {
  nodeId: string;
  authKey: string; // one-time display: shown to the operator, never persisted
  // References the TS_AUTH_KEY env var by name, not the literal authKey
  // value — set TS_AUTH_KEY to the authKey above, then run enrollCommand.
  enrollCommand: string;
}

export function buildEnrollCommand(nodeId: string): string {
  // The exact provisioning invocation, run from the C_Fusion repo root.
  // Deliberately does NOT embed the literal minted key: the command is a
  // durable, pasteable string (shell history, tmux logs, ticket/chat
  // pastes) whereas authKey is a one-time-display secret. The operator
  // exports TS_AUTH_KEY from the separately-returned authKey field first,
  // and this command references that env var by name ($TS_AUTH_KEY), which
  // setup-device.sh reads from its environment.
  // <central-broker-host>/<device-ip> are operator-supplied at run time.
  return (
    `TS_AUTH_KEY="$TS_AUTH_KEY" FLEET_NODE_ID='${nodeId}' ` +
    `FLEET_CENTRAL_HOST=<central-broker-host> ./scripts/setup-device.sh <device-ip>`
  );
}

export async function enrollFleetNode(
  deps: EnrollDeps,
  input: { nodeId: string; tags?: string[] },
): Promise<EnrollResult> {
  if (!NODE_ID.test(input.nodeId)) throw new Error(`invalid node id: ${input.nodeId}`);
  const { key } = await deps.tailscale.createAuthKey({
    description: `cfusion-${input.nodeId}`,
    tags: input.tags,
  });
  // The `cfusion-` prefix is what guarantees this id can't collide with the
  // ontology's reserved prefixes (datasource-/service-/container-/vm-/
  // dashboard-) — NODE_ID itself doesn't reject those. If this ever changes
  // to use the raw nodeId, add explicit reserved-prefix rejection.
  deps.ontology.upsert({
    id: `cfusion-${input.nodeId}`,
    title: `C_Fusion fleet node ${input.nodeId}`,
    subtype: "fleet-node",
    props: {
      nodeId: input.nodeId,
      ...(input.tags?.length ? { tags: input.tags.join(",") } : {}),
      enrolledAt: deps.now(),
    },
  });
  // Second audit line beyond the approval gate's: records that a key was
  // actually minted. The key itself is never written anywhere.
  //
  // Ordering semantics: validate -> mint -> ontology upsert -> append audit.
  // Audit append is best-effort-last: if it throws here, the node has
  // already been recorded in the ontology but this enrollment event won't
  // be audit-logged. That's acceptable — the durable security fact is the
  // minted one-time key (already handed back to the caller above this
  // point conceptually), and re-running enroll is safe since the ontology
  // upsert is idempotent. No rollback machinery is added for this case.
  appendInfraAudit(deps.auditPath, {
    ts: deps.now(),
    tool: "mcp__infra__enroll_fleet_node",
    input: { nodeId: input.nodeId, tags: input.tags ?? [] },
    decision: "approved",
    result: { nodeId: input.nodeId, authKeyIssued: true },
  });
  return {
    nodeId: input.nodeId,
    authKey: key,
    enrollCommand: buildEnrollCommand(input.nodeId),
  };
}
