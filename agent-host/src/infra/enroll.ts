import { appendInfraAudit } from "./audit.js";
import type { TailscaleClient } from "./tailscale.js";

// Same node-id alphabet as C_Fusion's fleet/bridge/render_bridge.py — the
// id becomes a MagicDNS hostname (cfusion-{id}) and an MQTT topic segment.
// Note: this alphabet is broader than what's valid in a DNS label/MagicDNS
// hostname (e.g. `.` and `_` and leading/trailing `-` behave differently in
// each context), so a nodeId accepted here could still diverge from the
// hostname Tailscale actually assigns. Not tightened here — flagged as a
// follow-up.
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
  authKey: string; // one-time display: shown to the operator, never written to RHUMBR's audit log or ontology
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

// Tailscale API keys require tags on the minted device (OAuth-client keys
// 400 on an untagged create; personal-key untagged devices instead hit
// node-key expiry (~180d) and silently fall off the tailnet). Default to a
// single well-known tag so callers can't accidentally mint an untagged,
// operationally-fragile key. The tailnet ACL must declare a tagOwners entry
// for tag:cfusion covering the API key's owner, or minting will 400.
const DEFAULT_TAGS = ["tag:cfusion"];

export async function enrollFleetNode(
  deps: EnrollDeps,
  input: { nodeId: string; tags?: string[] },
): Promise<EnrollResult> {
  if (!NODE_ID.test(input.nodeId)) throw new Error(`invalid node id: ${input.nodeId}`);
  const tags = input.tags?.length ? input.tags : DEFAULT_TAGS;
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
      tags: tags.join(","),
      enrolledAt: deps.now(),
    },
  });
  const { key } = await deps.tailscale.createAuthKey({
    description: `cfusion-${input.nodeId}`,
    tags,
  });
  // Second audit line beyond the approval gate's: records that a key was
  // actually minted. The key itself is never written anywhere.
  //
  // Ordering semantics: validate -> ontology upsert -> mint -> append audit.
  // Ontology upsert happens before minting: it's idempotent on retry, so a
  // recorded-but-not-yet-enrolled node is benign. Minting happens last
  // (before the final audit append) so that a failure anywhere upstream
  // (including the upsert) never leaves a live, unrecorded tailnet
  // credential stranded — the only way a key gets minted is right before
  // it's handed back to the caller. Audit append is still best-effort-last:
  // if it throws here, the node has already been recorded in the ontology
  // and the key already minted, but this enrollment event won't be
  // audit-logged. That's acceptable — the durable security fact is the
  // minted one-time key (already handed back to the caller above this
  // point conceptually), and re-running enroll is safe since the ontology
  // upsert is idempotent. No rollback machinery is added for this case.
  appendInfraAudit(deps.auditPath, {
    ts: deps.now(),
    tool: "mcp__infra__enroll_fleet_node",
    input: { nodeId: input.nodeId, tags },
    decision: "approved",
    result: { nodeId: input.nodeId, authKeyIssued: true },
  });
  return {
    nodeId: input.nodeId,
    authKey: key,
    enrollCommand: buildEnrollCommand(input.nodeId),
  };
}
