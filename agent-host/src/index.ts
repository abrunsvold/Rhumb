import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { loadConfig, type Config } from "./config.js";
import { RHUMB_PROMPT_APPEND } from "./prompt.js";
import { SessionManager, type QueryFn } from "./sessionManager.js";
import { createServer } from "./server.js";
import { createSessionService } from "./sessions.js";
import { sanitizedEnv } from "./env.js";
import { PROVIDER_CREDENTIAL_VARS } from "./provider.js";
import { loadInfraConfig } from "./infra/config.js";
import { createProxmoxClient, createPveCall } from "./infra/proxmox.js";
import { createNodeFactsRefresher, readNodeFactsFile } from "./infra/nodeFacts.js";
import { createDdlFactsRefresher, readDdlFactsFile } from "./infra/ddlFacts.js";
import { createAdminExecutor, createAdminQuery, connStringForDb } from "./infra/pgAdmin.js";
import { PendingActions } from "./infra/pending.js";
import { createInfraServer, makeCanUseTool, READ_TOOL_NAMES } from "./infra/server.js";
import { createGatedExecutor } from "./infra/executor.js";
import { appendInfraAudit } from "./infra/audit.js";
import type { PendingAction } from "./infra/types.js";
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

  const manager = new SessionManager({
    query: deps.query,
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
        disallowedTools: watchdogDisallowedTools(),
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
  const onListen = () => {
    const bound = config.insecureDev ? "all interfaces" : "127.0.0.1";
    console.log(
      `rhumb agent-host listening on ${bound}:${config.port} ` +
        `(provider ${config.provider.id}, model ${config.provider.model})`,
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
