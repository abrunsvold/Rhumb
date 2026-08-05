import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { loadConfig, type Config } from "./config.js";
import { RHUMB_PROMPT_APPEND } from "./prompt.js";
import { SessionManager, type QueryFn, type ResolvedAgentIdentity } from "./sessionManager.js";
import { createServer } from "./server.js";
import { createSessionService } from "./sessions.js";
import { sanitizedEnv } from "./env.js";
import { PROVIDER_CREDENTIAL_VARS } from "./provider.js";
import { createAgentRegistry, type AgentRegistry } from "./agents.js";
import { createMngrBackend } from "./backends/mngr.js";
import { createRealExec, assertMngrPrerequisites } from "./backends/exec.js";
import type { AgentBackend } from "./backends/types.js";
import { loadInfraConfig } from "./infra/config.js";
import { createProxmoxClient, createPveCall } from "./infra/proxmox.js";
import { createNodeFactsRefresher, readNodeFactsFile } from "./infra/nodeFacts.js";
import { createDdlFactsRefresher, readDdlFactsFile } from "./infra/ddlFacts.js";
import { createAdminExecutor, createAdminQuery, connStringForDb } from "./infra/pgAdmin.js";
import { PendingActions } from "./infra/pending.js";
import { createInfraServer, makeCanUseTool, READ_TOOL_NAMES } from "./infra/server.js";
import { createGatedExecutor } from "./infra/executor.js";
import { appendInfraAudit } from "./infra/audit.js";
import type { GatedTool, PendingAction } from "./infra/types.js";
import { createFleetOps, type FleetTask, type SpawnContext } from "./fleet/ops.js";
import { createFleetServer, FLEET_TOOL_NAMES, GATED_FLEET_TOOL_NAMES } from "./fleet/server.js";
import { createInfraRouter } from "./infra/router.js";
import { loadServiceConfig } from "./services/config.js";
import { createLxcClient } from "./services/lxc.js";
import { createSshExec } from "./services/ssh.js";
import { createDeployer } from "./services/deployer.js";
import { createServiceOps } from "./services/ops.js";
import { createHealthGate, createNetProbes } from "./services/health.js";
import { createDataSourceResolver } from "./services/datasource.js";
import { readManifest } from "./services/manifest.js";
import { createWatchdog, watchdogDisallowedTools, WATCHDOG_PROMPT } from "./watchdog.js";
import { loadOntologyConfig } from "./ontology/config.js";
import { createOntologyOps, ONTOLOGY_TOOL_NAMES } from "./ontology/ops.js";
import { createOntologyServer } from "./ontology/server.js";
import { createOntologyRouter } from "./ontology/router.js";
import { syncSystem } from "./ontology/projector.js";
import type { Express } from "express";

/** The fleet tools that require operator approval before they run — exactly
 *  `mcp__fleet__spawn`. Exported as the thing the wiring actually consumes so
 *  a test can assert the host gates what `src/fleet/server.ts` says must be
 *  gated (and, just as importantly, that it does NOT gate the read-only
 *  `check`/`collect`: forcing an approval to poll trains an operator to click
 *  through, which is a worse security outcome than one well-presented
 *  decision on the action that actually creates agents). */
export function fleetGatedToolNames(): string[] {
  return [...GATED_FLEET_TOOL_NAMES];
}

/** The one gated fleet tool, written once. The audit lines in `buildApp` use
 *  it so the log can never name a tool the gate does not match;
 *  `fleetServerKey` proves at boot that it is genuinely a name the SDK will
 *  publish and that the gate genuinely matches it. */
const FLEET_SPAWN_TOOL = "mcp__fleet__spawn";

/** The `mcpServers` key to register the fleet server under — read off the
 *  server the SDK actually constructed, never written as a literal here.
 *
 *  **Why this is not just `"fleet"`.** The SDK derives every tool's public
 *  name as `mcp__<server>__<tool>`, and `GATED_FLEET_TOOL_NAMES` — the set
 *  `makeFleetCanUseTool` matches against — is a list of those full names. A
 *  literal key at the registration site is unbound to that list: rename
 *  either side and `spawn` registers under a name the gated set does not
 *  contain, the gate falls through to ALLOW, and nothing fails. Task 6
 *  deferred this as "not exploitable while nothing consumes the constants";
 *  this file consumes them, so it is.
 *
 *  Binding it in two directions:
 *   1. the key IS the name the server was constructed with, so the key can
 *      never drift from the construction site;
 *   2. this throws at BOOT (not at spawn time, and not only in a test) if
 *      any name in `FLEET_TOOL_NAMES` does not carry that server's prefix,
 *      or if a gated name is not one of them — i.e. if a rename on either
 *      side has left the gate pointing at a tool that does not exist.
 *
 *  Fails closed by refusing to boot: an ungated `spawn` is worse than a
 *  host that will not start. */
export function fleetServerKey(server: { name: string }): string {
  const prefix = `mcp__${server.name}__`;
  if (!GATED_FLEET_TOOL_NAMES.has(FLEET_SPAWN_TOOL)) {
    throw new Error(
      `fleet wiring: "${FLEET_SPAWN_TOOL}" is no longer in GATED_FLEET_TOOL_NAMES ` +
        `(${[...GATED_FLEET_TOOL_NAMES].join(", ") || "empty"}) — the host would audit a name ` +
        "the approval gate does not match, i.e. spawn would run ungated.",
    );
  }
  const misprefixed = (FLEET_TOOL_NAMES as readonly string[]).filter((n) => !n.startsWith(prefix));
  if (misprefixed.length > 0) {
    throw new Error(
      `fleet wiring: MCP server is named "${server.name}" but FLEET_TOOL_NAMES contains ` +
        `${misprefixed.join(", ")}, which the SDK would never produce (it derives ${prefix}<tool>). ` +
        "One side was renamed without the other; the approval gate matches on these names, so " +
        "booting would leave mcp__*__spawn ungated.",
    );
  }
  const unknown = [...GATED_FLEET_TOOL_NAMES].filter(
    (n) => !(FLEET_TOOL_NAMES as readonly string[]).includes(n),
  );
  if (unknown.length > 0) {
    throw new Error(
      `fleet wiring: gated tool name(s) ${unknown.join(", ")} are not among the fleet's own tools ` +
        `(${FLEET_TOOL_NAMES.join(", ")}) — the gate would match nothing.`,
    );
  }
  return server.name;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };
/** Structurally identical to `src/infra/server.ts`'s own `CanUseTool` (which
 *  that module does not export). Declared here rather than exported from
 *  there because `src/infra/` is out of scope for this change. */
type CanUseTool = (toolName: string, input: Record<string, unknown>, opts: unknown) => Promise<PermissionResult>;

/** The operator gate for `mcp__fleet__spawn`.
 *
 *  **This is the infra gate's path, not a second one.** It enqueues into the
 *  SAME `PendingActions` queue, surfaces through the SAME `/infra/pending`
 *  route + SSE stream, is decided in the SAME client `ConfirmationDialog`,
 *  and is recorded in the SAME `appendInfraAudit` log as every gated infra
 *  mutation. Approvals stay one queue, in one place, with one ordering.
 *
 *  It is a separate FUNCTION only because `makeCanUseTool`
 *  (src/infra/server.ts) cannot be handed a non-infra tool name: its gated
 *  set is a module-private `Set` built from `GATED_TOOLS` and every name it
 *  recognises is `mcp__infra__*` — anything else it allows unconditionally,
 *  which is exactly the ungated-spawn outcome this exists to prevent. Making
 *  that set injectable would be the tidier fix and is the natural follow-up;
 *  it is not done here because this task must not modify `src/infra/`. What
 *  is deliberately NOT re-implemented is the decision machinery itself —
 *  the pending queue, its persistence, the resolve route, the audit writer
 *  are all the infra module's, reused as-is.
 *
 *  `next` chains to the infra gate when infra is configured, so one
 *  `canUseTool` covers both tool families. The fleet gate must apply whether
 *  or not infra is configured — a box without Proxmox is the common case and
 *  spawning agents there is no less consequential.
 *
 *  **The non-fleet fall-through, and why it is `allow` (F4).** Installing a
 *  `canUseTool` at all routes EVERY tool decision through this callback,
 *  including on a box that previously had none, so the fall-through result
 *  replaces whatever `permissionMode` would have decided. The SDK's
 *  `PermissionResult` is `{behavior:"allow"} | {behavior:"deny"}` — verified
 *  in `@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts`; there
 *  is NO "defer to the default policy" variant — so the only alternative to
 *  `allow` is denying every ordinary tool, which would break the host. Two
 *  things keep that from being a quiet widening: the callback is installed
 *  ONLY when the operator has explicitly enabled the fleet
 *  (`RHUMB_FLEET_ENABLED`, config.ts), and `buildApp` warns at boot, naming
 *  the effect, when it installs one where no gate existed before. Chaining
 *  to `next` is always preferred, so an infra-configured box keeps exactly
 *  the policy it had.
 *
 *  The audit records the SHAPE of the call (how many tasks) and the
 *  operator's decision, never the task prompts: prompts are the operator's
 *  own text but can be arbitrarily long, and the log is append-only. The
 *  operator still sees the full input in the approval dialog — only the log
 *  is summarised. */
export function makeFleetCanUseTool(deps: {
  pending: PendingActions;
  auditPath: string;
  now: () => string;
  /** The next gate in the chain (the infra one), or undefined when infra is
   *  not configured. */
  next?: CanUseTool;
}): CanUseTool {
  return async (toolName, input, opts) => {
    if (!GATED_FLEET_TOOL_NAMES.has(toolName)) {
      return deps.next ? deps.next(toolName, input, opts) : { behavior: "allow", updatedInput: input };
    }
    const shape = { taskCount: Array.isArray(input.tasks) ? input.tasks.length : null };
    // `PendingAction.tool` is typed `GatedTool` (an infra-tool union in
    // src/infra/types.ts, which this task must not edit). The queue itself
    // is name-agnostic — it stores the string and the client renders it —
    // so the full MCP tool name is stored as-is rather than mapped onto
    // some infra tool it is not: the operator's dialog and the audit line
    // must both say `mcp__fleet__spawn`, because that is what is being
    // approved.
    const { decision } = deps.pending.enqueue(toolName as GatedTool, input);
    let d: "approve" | "deny";
    try {
      d = await decision;
    } catch (e) {
      appendInfraAudit(deps.auditPath, { ts: deps.now(), tool: toolName, input: shape, decision: "error", error: String(e) });
      return { behavior: "deny", message: "Fleet spawn could not be confirmed." };
    }
    appendInfraAudit(deps.auditPath, { ts: deps.now(), tool: toolName, input: shape, decision: d === "approve" ? "approved" : "denied" });
    return d === "approve"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Operator denied this fleet spawn." };
  };
}

export function buildApp(deps: { config: Config; query: QueryFn }): Express {
  const sessionExtraOptions: Record<string, unknown> = {};
  sessionExtraOptions.disallowedTools = ["AskUserQuestion"];
  sessionExtraOptions.systemPrompt = { type: "preset", preset: "claude_code", append: RHUMB_PROMPT_APPEND };
  const infra = loadInfraConfig(process.env);
  let infraPending: PendingActions | undefined;
  let executeParked: ((a: PendingAction) => Promise<void>) | undefined;
  let watchdogCanUseTool: unknown;

  const onto = loadOntologyConfig(process.env);
  const readJson = <T>(p: string, fallback: T): T => {
    try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback; } catch { return fallback; }
  };
  const readJsonl = <T>(p: string): T[] => {
    try {
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
    } catch { return []; }
  };
  // Node facts need only the Proxmox half of the infra config (no pg-admin).
  const refreshNodeFacts = infra.proxmox
    ? createNodeFactsRefresher({
        call: createPveCall(infra.proxmox),
        address: infra.proxmox.baseUrl,
        path: onto.nodeFactsPath,
        now: () => new Date().toISOString(),
      })
    : undefined;
  // DDL facts need only the pg-admin half: the audit table is superuser-owned.
  const adminConn = infra.pgAdmin?.connectionString;
  const refreshDdlFacts = adminConn
    ? createDdlFactsRefresher({
        readSources: () => readJson<Array<{ id: string; connectionString: string }>>(infra.dataSourcesPath, []),
        queryDb: (db, sql) => createAdminQuery(connStringForDb(adminConn, db))(sql),
        path: onto.ddlFactsPath,
        now: () => new Date().toISOString(),
      })
    : undefined;
  // One refresh hook for all external facts; each half degrades independently.
  const refreshExternal = refreshNodeFacts || refreshDdlFacts
    ? async () => { await Promise.allSettled([refreshNodeFacts?.(), refreshDdlFacts?.()]); }
    : undefined;

  const ontologyOps = createOntologyOps({
    systemDir: onto.systemDir,
    domainDir: onto.domainDir,
    now: () => new Date().toISOString(),
    sync: () =>
      syncSystem({
        config: { systemDir: onto.systemDir },
        now: () => new Date().toISOString(),
        readDataSources: () => readJson<Array<{ id: string; type: string; mode: string }>>(onto.dataSourcesPath, []),
        readServices: () => readJson<Array<{ id: string; name: string; containerId: number; host: string; port: number; status: string }>>(onto.servicesPath, []),
        readSurfaceIds: () => (existsSync(onto.surfacesDir) ? readdirSync(onto.surfacesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []),
        readDataAudit: () => readJsonl<{ surfaceId: string | null; source: string; op: { kind: string } }>(onto.dataAuditPath),
        readInfraAudit: () => readJsonl<{ ts: string; tool: string; input: Record<string, unknown>; decision: string }>(onto.infraAuditPath),
        readNodeFacts: () => readNodeFactsFile(onto.nodeFactsPath),
        readDdlFacts: () => readDdlFactsFile(onto.ddlFactsPath),
      }),
  });

  if (infra.proxmox && infra.pgAdmin) {
    const pgAdmin = infra.pgAdmin;
    const now = () => new Date().toISOString();
    const pending = new PendingActions({ now, id: () => randomUUID(), persistPath: joinPath(deps.config.workspace, "pending-actions.json") });
    const svcCfg = loadServiceConfig(process.env);
    const serviceOps = svcCfg
      ? (() => {
          const sshExec = createSshExec();
          return createServiceOps({
            lxc: createLxcClient(infra.proxmox),
            deployer: createDeployer(sshExec),
            config: svcCfg,
            now,
            readManifest: (id) => readManifest(svcCfg.workspace, id),
            resolveDataSource: createDataSourceResolver(infra.dataSourcesPath),
            gate: createHealthGate({ exec: sshExec, ...createNetProbes(), deadlineMs: svcCfg.healthGateMs }),
          });
        })()
      : undefined;
    const infraDeps = {
      proxmox: createProxmoxClient(infra.proxmox),
      admin: createAdminExecutor(pgAdmin.connectionString),
      dataSourcesPath: infra.dataSourcesPath,
      auditPath: infra.auditPath,
      now,
      password: () => randomUUID().replace(/-/g, ""),
      adminConnectionString: pgAdmin.connectionString,
      adminExecForDb: (db: string) => createAdminExecutor(connStringForDb(pgAdmin.connectionString, db)),
      serviceOps,
      onMutate: () => {
        // Facts refresh is fire-and-forget (next sync reads whatever landed);
        // the sync itself stays synchronous and must never fail the infra op.
        void refreshExternal?.().catch(() => {});
        try { ontologyOps.sync(); } catch { /* never fail the infra op */ }
      },
    };
    const server = createInfraServer(infraDeps);
    sessionExtraOptions.mcpServers = { infra: server };
    sessionExtraOptions.allowedTools = [...READ_TOOL_NAMES];
    sessionExtraOptions.canUseTool = makeCanUseTool({ pending, auditPath: infra.auditPath, now });
    // Unattended (watchdog) sessions park proposals instead of blocking.
    watchdogCanUseTool = makeCanUseTool({ pending, auditPath: infra.auditPath, now }, { mode: "parked", proposedBy: "watchdog" });
    // Approved parked entries execute here, outside any turn, with the same
    // executor the in-turn tool handlers use.
    const gatedExecutor = createGatedExecutor(infraDeps);
    executeParked = async (a) => {
      try {
        const result = await gatedExecutor.execute(a.tool, a.input);
        pending.recordOutcome(a.pendingId, "executed", result);
        appendInfraAudit(infra.auditPath, { ts: now(), tool: `mcp__infra__${a.tool}`, input: a.input, decision: "executed", result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pending.recordOutcome(a.pendingId, "failed", msg);
        appendInfraAudit(infra.auditPath, { ts: now(), tool: `mcp__infra__${a.tool}`, input: a.input, decision: "error", error: msg });
      }
    };
    infraPending = pending;
  }

  const ontologyServer = createOntologyServer(ontologyOps);
  sessionExtraOptions.mcpServers = { ...(sessionExtraOptions.mcpServers as object ?? {}), ontology: ontologyServer };
  sessionExtraOptions.allowedTools = [ ...((sessionExtraOptions.allowedTools as string[]) ?? []), ...ONTOLOGY_TOOL_NAMES ];

  // ---------------------------------------------------------------- fleet --
  // The fleet ALWAYS spawns through mngr, whatever backend this conversation
  // uses — so a fast sdk foreground turn can dispatch a background mngr
  // fleet. mngr's prerequisites gate THIS BLOCK only, never the whole host
  // (unlike RHUMB_AGENT_BACKEND=mngr below, where they are a boot condition).
  //
  // Three preconditions, checked in this order:
  //  1. `RHUMB_FLEET_ENABLED` must be on (`config.fleetEnabled`, default
  //     OFF — see `loadFleetEnabled`). The kill switch, and the reason an
  //     operator upgrading a box that already has mngr on PATH does not
  //     silently acquire model-directed spawning.
  //  2. `config.fleetCaps` must be present. `checkCaps` (src/fleet/caps.ts)
  //     is the ONLY limit on model-directed spawning; a Config without caps
  //     cannot enforce one, so the fleet is not offered at all rather than
  //     offered unbounded. `loadConfig` always supplies them, so this only
  //     fires for a partial Config.
  //  3. mngr's CLI prerequisites must be present. Checked LAST because
  //     `assertMngrPrerequisites` shells out (`command -v`, `bash`): a host
  //     that never asked for a fleet must neither pay for that nor have its
  //     behaviour depend on what happens to be installed.
  let fleetAvailable = Boolean(deps.config.fleetEnabled && deps.config.fleetCaps);
  if (fleetAvailable) {
    try {
      assertMngrPrerequisites();
    } catch (e) {
      fleetAvailable = false;
      console.warn(`[rhumb] fleet tools unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The MCP servers an UNATTENDED (watchdog) session may have — snapshotted
  // before the fleet is added, because it must never be one of them. See the
  // watchdog manager below.
  let watchdogMcpServers: object | undefined;
  // Shared with the RHUMB_AGENT_BACKEND=mngr block below — see the comment
  // at its `registry` for why there must be exactly one instance per file.
  let fleetRegistry: AgentRegistry | undefined;
  // The principal spawning a fleet, when it is knowable. Assigned by the
  // RHUMB_AGENT_BACKEND=mngr block below, which is the only path where the
  // operator's own conversation HAS a principal — see the ctx thunk.
  let foregroundAgentId: () => string | null = () => null;

  if (fleetAvailable) {
    const fleetNow = () => new Date().toISOString();
    const fleetSpec = {
      model: deps.config.provider.model,
      workspace: deps.config.workspace,
      permissionMode: deps.config.permissionMode,
      // NOT `sessionExtraOptions`: a spawned agent inherits no tool policy
      // from the operator's conversation, and in particular inherits no
      // fleet (see the ctx thunk below). The one thing it does inherit is
      // the AskUserQuestion ban, and it needs it MORE than the foreground
      // does: a background agent has no operator attached, so a question it
      // asks is a question nobody will ever answer — it would block until
      // the reply timeout with nothing to show for it.
      extraOptions: { disallowedTools: ["AskUserQuestion"] },
    };
    fleetRegistry = createAgentRegistry({
      indexPath: joinPath(deps.config.workspace, "agents.json"),
      now: fleetNow,
      id: () => `rhumb-${randomUUID()}`,
    });
    const fleetBackend = createMngrBackend({
      exec: createRealExec(),
      registry: fleetRegistry,
      credentialEnv: deps.config.provider.credentialEnv,
      spec: fleetSpec,
      // Same wildcard blanking the RHUMB_AGENT_BACKEND=mngr path uses below
      // — see the long comment there for why it is computed here.
      extraBlankedVars: Object.keys(process.env).filter((k) => k.startsWith("RHUMB_")),
    });
    const fleetOps = createFleetOps({
      backend: fleetBackend,
      registry: fleetRegistry,
      caps: deps.config.fleetCaps,
      spec: fleetSpec,
      mintName: () => `fleet-${randomUUID().slice(0, 8)}`,
      // Both are honest `null` stubs, not guesses: `null` means UNKNOWABLE,
      // so `check` reports "unknown" rather than inventing a status. Real
      // wiring is a follow-up and needs two things the fleet backend does
      // not expose publicly yet: `mngr list --format json` parsed into a
      // nativeId -> liveness map (its fields are snake_case — `waiting_reason`
      // maps to `waitingReason` in MngrLiveness, src/fleet/status.ts), and
      // `mngr transcript` read for the last assistant finish_reason.
      liveness: async () => null,
      lastFinishReason: async () => null,
    });

    // Every spawn is audited, on every box. The brief anticipated skipping
    // this where `infra.auditPath` is absent — it never is: `loadInfraConfig`
    // always returns an auditPath (defaulting to
    // `<workspace>/infra-audit.jsonl`), and only the infra TOOLS are
    // conditional on Proxmox/pg-admin config. `appendInfraAudit` creates the
    // parent directory itself, so there is no unaudited-spawn gap to
    // document.
    //
    // Two lines land per approved call: the gate's ("approved"/"denied", from
    // makeFleetCanUseTool) and this one ("executed"/"error"), adjacent and
    // both naming `mcp__fleet__spawn`. Together they answer "which agents
    // were created, spawned by whom, at what depth, under whose
    // authorization" without reconstruction. Task prompts are NOT recorded
    // (they can be long and the log is append-only) — the count and the
    // lineage are.
    const auditedOps = {
      ...fleetOps,
      async spawn(tasks: FleetTask[], ctx: SpawnContext) {
        const ts = fleetNow();
        const input = { taskCount: tasks.length, parentAgentId: ctx.parentAgentId, depth: ctx.depth };
        try {
          const outcomes = await fleetOps.spawn(tasks, ctx);
          appendInfraAudit(infra.auditPath, {
            ts,
            tool: FLEET_SPAWN_TOOL,
            input,
            decision: "executed",
            result: {
              spawned: outcomes.flatMap((o) => (o.ok ? [o.agentId] : [])),
              failed: outcomes.filter((o) => !o.ok).length,
            },
          });
          return outcomes;
        } catch (e) {
          // A cap breach throws with zero principals created. That must
          // leave a trace too — a refused spawn is exactly the event an
          // operator wants to find later.
          appendInfraAudit(infra.auditPath, {
            ts,
            tool: FLEET_SPAWN_TOOL,
            input,
            decision: "error",
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      },
    };

    // WHY depth 0 IS CORRECT HERE, AND ONLY HERE.
    //
    // `ops.spawn` enforces the depth cap against whatever this thunk returns
    // — the tool schema deliberately cannot carry `depth`/`parentAgentId`
    // (see createFleetServer's doc comment), so this call site IS the depth
    // cap. Hardcoding `{ parentAgentId: null, depth: 0 }` is correct because
    // THIS host process serves the OPERATOR'S OWN conversation, which is a
    // genuine root: it is reached over HTTP by an authenticated operator
    // (src/server.ts identity gate), never by another agent, and nothing
    // upstream of it is an agent that could be a parent.
    //
    // A host serving a SPAWNED CHILD must NOT reuse this value. Doing so
    // would let a child claim to be a root and the depth cap would be evaded
    // through the front door — no schema change or model trickery required,
    // just the wrong constant at the wrong call site. Such a host must
    // derive the thunk from the child's own registry record
    // (`{ parentAgentId: rec.agentId, depth: rec.depth }`, both already
    // recorded by `registry.create` at spawn time).
    //
    // In this slice no spawned agent can reach these tools at all: the fleet
    // MCP server is an in-process JS object and `agentArgsFor`
    // (src/backends/mngr.ts) carries only --model/--permission-mode/
    // --allowedTools/--disallowedTools/--append-system-prompt across the mngr
    // CLI boundary; `mcpServers` structurally cannot cross it, and the spec
    // above carries only a disallow list regardless.
    //
    // `parentAgentId` is the operator conversation's OWN principal where one
    // exists, so the audit can answer "spawned by whom" instead of always
    // saying null. It exists only under RHUMB_AGENT_BACKEND=mngr; on the sdk
    // path the operator's conversation is not a principal at all and `null`
    // is the honest answer, not a placeholder. `depth` stays 0 either way —
    // an operator conversation is a root whether or not it has a principal.
    const fleetServer = createFleetServer(auditedOps, () => ({
      parentAgentId: foregroundAgentId(),
      depth: 0,
    }));

    // The approval surface. When infra is configured we reuse ITS queue; when
    // it is not, we create the queue here AND publish it as `infraPending` so
    // the /infra router (the client's only approval channel) still mounts.
    // Without that, `mcp__fleet__spawn` on a non-Proxmox box — the common
    // case — would either be ungated or block on a dialog no operator could
    // ever see: wedged, not gated.
    const pending =
      infraPending ??
      new PendingActions({
        now: fleetNow,
        id: () => randomUUID(),
        persistPath: joinPath(deps.config.workspace, "pending-actions.json"),
      });
    infraPending = pending;
    const priorCanUseTool = sessionExtraOptions.canUseTool as CanUseTool | undefined;
    if (!priorCanUseTool) {
      // F4: on a box with no infra gate this callback is NEW, and the SDK
      // routes every tool decision through it once it exists. Its non-fleet
      // fall-through is `allow` because PermissionResult has no
      // defer-to-default variant (see makeFleetCanUseTool) — so say so, out
      // loud, at the one moment an operator is looking.
      console.warn(
        "[rhumb] WARNING: enabling the fleet installs a tool-permission callback (canUseTool) " +
          "on a host that had none. mcp__fleet__spawn now requires operator approval, but every " +
          "OTHER tool is answered 'allow' by that callback rather than by the SDK's own " +
          `permission-mode policy (RHUMB_PERMISSION_MODE=${deps.config.permissionMode}). Unset ` +
          "RHUMB_FLEET_ENABLED to restore the previous behaviour.",
      );
    }
    sessionExtraOptions.canUseTool = makeFleetCanUseTool({
      pending,
      auditPath: infra.auditPath,
      now: fleetNow,
      // Chains to the infra gate when there is one, so a single canUseTool
      // covers both families and neither loses its gate.
      next: priorCanUseTool,
    });
    if (deps.config.permissionMode === "bypassPermissions") {
      // F5: the SDK skips canUseTool entirely in this mode, so the approval
      // gate above never runs. Inherited from the infra precedent, but the
      // stakes are higher here — this one creates agents.
      console.warn(
        "[rhumb] WARNING: RHUMB_PERMISSION_MODE=bypassPermissions makes the SDK skip the " +
          "tool-approval callback, so fleet spawns will NOT prompt for approval — the model can " +
          "create background agents (up to the fleet caps) with no operator decision. Spawns are " +
          "still audited. Use a different permission mode if you want the gate to run.",
      );
    }

    watchdogMcpServers = { ...(sessionExtraOptions.mcpServers as object ?? {}) };
    // F1: the key is read off the server, never written as a literal, and
    // cross-checked against the gated names — see `fleetServerKey`.
    sessionExtraOptions.mcpServers = {
      ...(sessionExtraOptions.mcpServers as object ?? {}),
      [fleetServerKey(fleetServer)]: fleetServer,
    };
    // Only the read-only tools are pre-allowed; `spawn` is left out on
    // purpose so it falls through to canUseTool above — the same shape
    // READ_TOOL_NAMES/GATED_TOOLS give the infra server.
    sessionExtraOptions.allowedTools = [
      ...((sessionExtraOptions.allowedTools as string[]) ?? []),
      ...FLEET_TOOL_NAMES.filter((n) => !GATED_FLEET_TOOL_NAMES.has(n)),
    ];
  }

  // The watchdog manager below (see WATCHDOG_MINUTES branch further down)
  // deliberately stays on the SDK path: it is a read-only reconcile turn
  // whose tool policy is the point, and slice 1 does not model unattended
  // agents as principals.
  let backend: AgentBackend | undefined;
  let resolveAgentId: ((sessionId: string | undefined) => ResolvedAgentIdentity) | undefined;
  let releaseAgentId: ((agentId: string) => void) | undefined;
  if (deps.config.agentBackend === "mngr") {
    // Fails at boot on the CLI/bash prerequisites (assertMngrPrerequisites,
    // exec.ts) per commits 462acd6 / fb30c3d (validate eagerly, fail
    // closed). Whatever of sessionExtraOptions cannot cross the mngr CLI
    // boundary (in-process MCP servers, canUseTool) does NOT block boot —
    // createMngrBackend (mngr.ts, I7) only WARNS about those, once, since
    // Phase 0's corrected analysis (fix round 2) found that dropping them
    // is a capability REDUCTION, not a gate bypass: the tools canUseTool
    // gates are served BY the dropped MCP server, so with it gone there is
    // nothing left to gate. sessionExtraOptions.mcpServers carries at least
    // the ontology server on every box (set unconditionally above, not only
    // when infra is configured), so that warning fires whenever
    // RHUMB_AGENT_BACKEND=mngr is selected today — see
    // warnAboutUncarriableSpec's doc comment in mngr.ts for the full
    // reasoning.
    assertMngrPrerequisites();
    // ONE registry instance per process over `agents.json`, shared with the
    // fleet above when that is wired. `createAgentRegistry` loads the file
    // once at construction and rewrites it WHOLE on every mutation
    // (`persist`, agents.ts), so two instances over the same path would each
    // overwrite the other's records from a stale in-memory snapshot — the
    // fleet's principals would vanish from disk on the operator's next turn,
    // and `check`/`collect` would then answer "unknown" for agents that are
    // genuinely running.
    const registry =
      fleetRegistry ??
      createAgentRegistry({
        indexPath: joinPath(deps.config.workspace, "agents.json"),
        now: () => new Date().toISOString(),
        id: () => `rhumb-${randomUUID()}`,
      });
    backend = createMngrBackend({
      exec: createRealExec(),
      registry,
      credentialEnv: deps.config.provider.credentialEnv,
      spec: {
        model: deps.config.provider.model,
        workspace: deps.config.workspace,
        permissionMode: deps.config.permissionMode,
        extraOptions: sessionExtraOptions,
      },
      // sanitizedEnv (env.ts) strips every ambient RHUMB_* var for the SDK
      // path via a dynamic wildcard scan; mngr.ts can only blank a fixed
      // list, so the wildcard is computed here — over THIS process's own
      // process.env, not the mngr tmux server's, which can differ (I2,
      // deferred; see mngr.ts's credentialEnvFlags doc comment for the
      // asymmetry and the tmux kill-server operator requirement it
      // implies) — and threaded through as the additive extraBlankedVars dep.
      extraBlankedVars: Object.keys(process.env).filter((k) => k.startsWith("RHUMB_")),
    });
    // C1: without this, every mngr turn arrives with agentId "" (no
    // principal is ever minted) and fails VALID_MNGR_NAME on every single
    // message. See createMngrAgentIdResolver's doc comment.
    //
    // In-memory, process-local record of which principals are currently
    // mid-turn (fix round 4, B2). Lives here — not in the registry, which
    // is on-disk and shared, and not in the resolver itself, which is a
    // pure function recreated fresh on every call — because "in flight" is
    // inherently transient, request-scoped state: it must reset if the
    // process restarts (a principal cannot still be "in flight" from a
    // turn that died with the old process), and it must be visible to
    // BOTH the resolver (to exclude an in-flight principal from
    // reuse-before-mint) and the release callback (to clear it once the
    // turn completes) — a plain closed-over Set is the minimal thing that
    // satisfies both without threading it through the registry's on-disk
    // schema.
    const inFlightMngrAgentIds = new Set<string>();
    resolveAgentId = createMngrAgentIdResolver(registry, { inFlight: inFlightMngrAgentIds });
    releaseAgentId = (agentId) => {
      inFlightMngrAgentIds.delete(agentId);
    };
    // F6: the fleet's `parentAgentId`. A spawn only ever happens DURING a
    // turn, and `inFlight` holds exactly the principals whose turn is
    // currently running — so with one turn in flight, that principal is the
    // one calling `spawn`. With zero (no turn — nothing can be spawning) or
    // more than one (concurrent conversations), which one is the caller is
    // genuinely not knowable at this layer: the MCP tool handler carries no
    // session identity, so there is nothing to disambiguate with. `null`
    // then, honestly, rather than a guess that would attribute one
    // operator's fleet to another's conversation in the audit. Threading a
    // real per-turn identity down to the tool handler is the proper fix and
    // is a follow-up.
    foregroundAgentId = () => {
      const inFlight = [...inFlightMngrAgentIds];
      return inFlight.length === 1 ? inFlight[0] : null;
    };
  }

  const manager = new SessionManager({
    query: deps.query,
    backend,
    resolveAgentId,
    releaseAgentId,
    model: deps.config.provider.model,
    workspace: deps.config.workspace,
    permissionMode: deps.config.permissionMode,
    extraOptions: sessionExtraOptions,
  });
  const sessions = createSessionService({
    indexPath: joinPath(deps.config.workspace, "sessions.json"),
    projectsDir: joinPath(homedir(), ".claude", "projects"),
    workspace: resolvePath(deps.config.workspace),
    now: () => new Date().toISOString(),
  });
  const app = createServer({
    manager,
    workspace: deps.config.workspace,
    sessions,
    identity: {
      allowedUsers: deps.config.allowedUsers,
      insecureDev: deps.config.insecureDev,
      controlToken: deps.config.controlToken,
    },
  });

  if (infraPending) {
    app.use("/infra", express.json(), createInfraRouter({
      pending: infraPending,
      executeParked,
      auditResolution: (a, decision) =>
        appendInfraAudit(infra.auditPath, { ts: new Date().toISOString(), tool: `mcp__infra__${a.tool}`, input: a.input, decision }),
    }));
  }
  app.use("/ontology", createOntologyRouter({ ops: ontologyOps, refresh: refreshExternal }));

  if (deps.config.watchdogMinutes) {
    // A second manager over the same query fn, differing only in tool policy:
    // mutation is structurally impossible (see watchdogDisallowedTools).
    const watchdogManager = new SessionManager({
      query: deps.query,
      model: deps.config.provider.model,
      workspace: deps.config.workspace,
      permissionMode: deps.config.permissionMode,
      extraOptions: {
        ...sessionExtraOptions,
        // The fleet is never carried into an UNATTENDED session — belt
        // (drop the server, so the tools do not exist) and braces (name them
        // disallowed anyway). Two independent reasons: spawning background
        // agents is a mutation, and this session is structurally read-only;
        // and the fleet gate BLOCKS on an operator decision, which an
        // unattended turn has nobody to make — it would hang, not park, and
        // the parked-mode gate below cannot help because it only knows infra
        // tool names.
        ...(watchdogMcpServers ? { mcpServers: watchdogMcpServers } : {}),
        disallowedTools: [...watchdogDisallowedTools(), ...FLEET_TOOL_NAMES],
        // Parked gate: proposals queue for approval instead of blocking the
        // unattended turn. Only present when infra is configured at all.
        ...(watchdogCanUseTool ? { canUseTool: watchdogCanUseTool } : {}),
      },
    });
    app.locals.watchdog = createWatchdog({
      intervalMs: deps.config.watchdogMinutes * 60_000,
      runTurn: () =>
        watchdogManager.run(WATCHDOG_PROMPT, undefined, (e) => {
          if (e.type === "session" && e.sessionId) {
            sessions.upsertFromTurn(e.sessionId, `Watchdog — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
          }
        }),
      log: (m) => console.error(m),
    });
  }

  return app;
}

/** Resolves the durable Rhumb principal a backend with a real lifecycle
 *  (mngr) needs. `SessionManager` never imports `AgentRegistry` itself;
 *  this closure is how `buildApp` supplies the behaviour without that
 *  import.
 *
 *  Exported (not just used inline) so `test/index-agentid.test.ts` can drive
 *  it directly against a real, tmp-dir-backed `AgentRegistry` — no mngr, no
 *  network, no SessionManager or backend involved.
 *
 *  **`nativeId` is ALWAYS `null` (fix round 4, B1).** Earlier drafts tried
 *  to derive `nativeId` from the registry record (round 3, A1) so an
 *  unverified wire value could never be trusted directly. That fixed the
 *  ownership bypass, but it left one consequence unfixed: `mngr.ts`'s
 *  `send()` only calls `ensureAgent` — which is where the ACTUAL liveness
 *  check, dead-agent respawn, and stopped-principal refusal all live —
 *  when `nativeId` is falsy. Handing back a non-null `nativeId` for a
 *  bound principal, even one correctly read from the registry, still
 *  pre-empted `ensureAgent` on every turn after the first, so a principal
 *  that died after being bound (box reboot, tmux kill) would error instead
 *  of respawning, and a principal stopped after being bound could still be
 *  messaged. `ensureAgent` already handles a bound principal correctly —
 *  `liveIds()` → return the existing `nativeId` if live → else
 *  resolve-by-label → re-create (mngr.ts) — it was simply never reached.
 *  The resolver does not need to perform a liveness check itself; it only
 *  needs to stop pre-empting the one that already exists, by always
 *  routing the turn back through `ensureAgent`. The cost is one extra
 *  `mngr list` exec per turn, which is acceptable. The per-record
 *  `nativeId`/`status` lookup this function used to do for that purpose is
 *  gone — it would be dead logic now that the return value never depends
 *  on it.
 *
 *  Two cases decide `agentId` (the wire-echo/ownership-bypass fix from
 *  round 3, A1, still applies to agentId — an unrecognised or foreign
 *  `sessionId` still never becomes a nativeId, it just also can't become
 *  one now that nativeId is unconditionally null):
 *   1. An incoming `sessionId` already bound as some principal's
 *      `nativeId` (the mngr agent id the CLIENT was handed on a PREVIOUS
 *      turn's `session` event), OR one that is itself already a known
 *      `agentId` (defensive; fix round 3, Minor 2): resolves to that SAME
 *      `agentId`.
 *   2. No incoming `sessionId`, or one that matches neither (a stale or
 *      foreign id): resolves via `resolveOrMintAgentId` below — reuse the
 *      newest still-ACTIVE, still-UNBOUND, NOT-currently-in-flight mngr
 *      principal (fix round 3, A2), or mint a new one.
 *
 *  **In-flight tracking (fix round 4, B2).** Every `agentId` this function
 *  hands back — in EITHER case above — is added to `inFlight` before
 *  returning, and `buildApp` wires a matching `releaseAgentId` callback
 *  (see there) that removes it once the turn completes. This is what keeps
 *  A2's reuse-before-mint from colliding two concurrent NEW conversations
 *  onto one principal: both arrive as `sessionId: undefined`, and the
 *  window during which a freshly-minted principal stays unbound is not
 *  tight — it spans a real `mngr create` (tens of seconds per Phase 0). Two
 *  such turns overlapping would otherwise both resolve to the SAME unbound
 *  principal, both call `ensureAgent` for it, and land both prompts (and
 *  both replies) in ONE transcript — exactly the 1:1 agentId<->nativeId
 *  binding `bindIfUnclaimed` in mngr.ts exists to protect, reopened through
 *  the reuse path A2 introduced. Marking a principal in-flight the moment
 *  it is handed out, and excluding in-flight principals from the reuse
 *  candidate pool, means a second concurrent turn mints its own instead. */
export function createMngrAgentIdResolver(
  registry: AgentRegistry,
  opts?: {
    /** Defaults to a fresh, always-valid-for-VALID_MNGR_NAME name. Injected
     *  in tests that need a deterministic or distinguishable name. */
    mintDisplayName?: () => string;
    /** Process-local record of principals currently mid-turn — see the
     *  B2 section of this function's doc comment. Defaults to a private
     *  `Set` when omitted (each call to `createMngrAgentIdResolver` then
     *  tracks its own in-flight state), but `buildApp` always supplies one
     *  it shares with a `releaseAgentId` callback, since in-flight tracking
     *  is only meaningful when hand-out and release share the same Set. */
    inFlight?: Set<string>;
  },
): (sessionId: string | undefined) => { agentId: string; nativeId: string | null } {
  const mintDisplayName = opts?.mintDisplayName ?? (() => `rhumb-${randomUUID().slice(0, 8)}`);
  const inFlight = opts?.inFlight ?? new Set<string>();

  // A2 (reuse before mint) + B2 (never reuse an in-flight principal).
  const resolveOrMintAgentId = (): string => {
    const unbound = registry
      .list()
      .filter(
        (r) =>
          r.backend === "mngr" &&
          r.status === "active" &&
          r.nativeId === null &&
          !inFlight.has(r.agentId) &&
          // Root principals only. Since the fleet shares this registry (see
          // buildApp), the unbound pool now also contains FLEET CHILDREN —
          // minted at `depth: parent.depth + 1` inside `spawn`'s mutex and
          // left unbound for as long as `mngr create` takes (tens of
          // seconds, Phase 0). Without this clause, an operator turn
          // arriving in that window would adopt a child that was spawned
          // for someone else's task: the operator's prompt would land in
          // the child's transcript, and the fleet's own `ensure` would find
          // its principal already claimed. The reuse-before-mint
          // optimisation (A2) exists to recycle principals minted FOR
          // operator conversations; a spawned child was never one of those.
          r.depth === 0,
      )
      // Newest first. Must return 0 on a tie — a comparator that only ever
      // returns -1/1 is non-conforming (fix round 4, Minor: the previous
      // version did exactly that).
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))[0];
    return unbound ? unbound.agentId : registry.create(mintDisplayName(), "mngr").agentId;
  };

  return (sessionId) => {
    let agentId: string;
    if (sessionId) {
      const bound = registry.list().find((r) => r.nativeId === sessionId);
      if (bound) {
        agentId = bound.agentId;
      } else {
        const direct = registry.get(sessionId);
        agentId = direct ? direct.agentId : resolveOrMintAgentId();
      }
    } else {
      agentId = resolveOrMintAgentId();
    }
    // B2: mark this principal in-flight for the whole turn, regardless of
    // which case produced it — see the doc comment above.
    inFlight.add(agentId);
    return { agentId, nativeId: null };
  };
}

// Wrap the SDK's query so it matches our narrowed QueryFn signature. The env we
// hand the SDK is what the spawned Claude Code process sees: the selected
// provider's credentials, with no RHUMB_* var and no credential or
// provider-selection var Rhumb knows about surviving from the host's own
// environment. Unrelated vars (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, …) do pass
// through — see sanitizedEnv for the exact guarantee.
export function createRealQuery(credentialEnv: Record<string, string>): QueryFn {
  // Validate eagerly, once. sanitizedEnv throws on a miswired credentialEnv,
  // but the closure below runs lazily — first on the first user turn — so a
  // miswiring would otherwise surface as a failed turn on a host that had
  // already logged healthy. main() calls this before the server listens, so
  // doing the work here puts the error at startup where the operator is
  // looking. The result is intentionally discarded: each turn rebuilds it from
  // the then-current process.env.
  sanitizedEnv(process.env, credentialEnv);
  return (args) =>
    sdkQuery({
      ...args,
      options: { ...args.options, env: sanitizedEnv(process.env, credentialEnv) },
    } as never);
}

// Vars an operator may have set ambiently for corporate mTLS. They are always
// stripped (see PROVIDER_CREDENTIAL_VARS in provider.ts) and never end up in
// `credentialEnv`, so — unlike a missing ANTHROPIC_AUTH_TOKEN, which fails
// loudly at boot — losing them fails silently: every model request breaks
// with an opaque TLS handshake error and nothing points at the cause. Warn at
// startup instead. Never log the value, only the variable name.
export function warnIfClientCertVarsPresent(env: NodeJS.ProcessEnv): void {
  const present = PROVIDER_CREDENTIAL_VARS.filter(
    (name) => name.startsWith("CLAUDE_CODE_CLIENT_") && env[name] !== undefined,
  );
  if (present.length > 0) {
    console.warn(
      `[rhumb] WARNING: ${present.join(", ")} set in the environment but no longer passed to the agent — if your endpoint requires client-cert (mTLS) auth, model requests will fail.`,
    );
  }
}

export function main(): void {
  const config = loadConfig(process.env);
  warnIfClientCertVarsPresent(process.env);
  // Credentials reach the SDK only through the env we build per query — the
  // host's own process env is never passed through unfiltered.
  mkdirSync(config.workspace, { recursive: true });
  const app = buildApp({ config, query: createRealQuery(config.provider.credentialEnv) });
  // Timers start only here — buildApp callers (tests) drive tick() directly.
  (app.locals.watchdog as { start(): void } | undefined)?.start();
  if (config.watchdogMinutes) {
    console.log(`[rhumb] watchdog: read-only reconcile session every ${config.watchdogMinutes}m`);
  }
  // Positive confirmation of a capability that is OFF by default: buildApp
  // warns when the fleet is enabled but unusable, and this says when it is
  // live. An operator should never have to guess whether the model on this
  // host can create agents.
  if (config.fleetEnabled) {
    const c = config.fleetCaps;
    console.log(
      `[rhumb] fleet: model-directed spawning ENABLED (max ${c.maxPerSpawn}/spawn, ` +
        `${c.maxConcurrent} concurrent, depth ${c.maxDepth}); every spawn requires operator approval`,
    );
  }
  const onListen = () => {
    const bound = config.insecureDev ? "all interfaces" : "127.0.0.1";
    console.log(
      `rhumb agent-host listening on ${bound}:${config.port} ` +
        `(provider ${config.provider.id}, model ${config.provider.model}, ` +
        `agent backend ${config.agentBackend})`,
    );
    if (config.insecureDev) {
      console.warn(
        "[rhumb] WARNING: RHUMB_INSECURE_DEV=1 — identity auth is OFF and the " +
          "host binds all interfaces. Control-token auth applies only if " +
          "RHUMB_CONTROL_TOKEN is set. Never run this mode outside local development.",
      );
    } else {
      console.log(
        `[rhumb] identity mode: loopback-only, ${config.allowedUsers.length} allowed user(s); ` +
          "reachable via tailscale serve at /agent",
      );
    }
  };
  // Dev mode binds the unspecified address (dual-stack, matching pre-identity
  // behavior so ::1 localhost clients keep working); identity mode pins
  // loopback so tailscale serve is the only network path in.
  if (config.insecureDev) app.listen(config.port, onListen);
  else app.listen(config.port, "127.0.0.1", onListen);
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
