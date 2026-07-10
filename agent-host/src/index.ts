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
import { loadInfraConfig } from "./infra/config.js";
import { createProxmoxClient } from "./infra/proxmox.js";
import { createAdminExecutor, connStringForDb } from "./infra/pgAdmin.js";
import { PendingActions } from "./infra/pending.js";
import { createInfraServer, makeCanUseTool, READ_TOOL_NAMES } from "./infra/server.js";
import { createInfraRouter } from "./infra/router.js";
import { loadServiceConfig } from "./services/config.js";
import { createLxcClient } from "./services/lxc.js";
import { createSshExec } from "./services/ssh.js";
import { createDeployer } from "./services/deployer.js";
import { createServiceOps } from "./services/ops.js";
import { createHealthGate, createNetProbes } from "./services/health.js";
import { createDataSourceResolver } from "./services/datasource.js";
import { readManifest } from "./services/manifest.js";
import { loadOntologyConfig } from "./ontology/config.js";
import { createOntologyOps, ONTOLOGY_TOOL_NAMES } from "./ontology/ops.js";
import { createOntologyServer } from "./ontology/server.js";
import { syncSystem } from "./ontology/projector.js";
import type { Express } from "express";

export function buildApp(deps: { config: Config; query: QueryFn }): Express {
  const sessionExtraOptions: Record<string, unknown> = {};
  sessionExtraOptions.disallowedTools = ["AskUserQuestion"];
  sessionExtraOptions.systemPrompt = { type: "preset", preset: "claude_code", append: RHUMB_PROMPT_APPEND };
  const infra = loadInfraConfig(process.env);
  let infraPending: PendingActions | undefined;

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
      }),
  });

  if (infra.proxmox && infra.pgAdmin) {
    const pgAdmin = infra.pgAdmin;
    const now = () => new Date().toISOString();
    const pending = new PendingActions({ now, id: () => randomUUID() });
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
    const server = createInfraServer({
      proxmox: createProxmoxClient(infra.proxmox),
      admin: createAdminExecutor(pgAdmin.connectionString),
      dataSourcesPath: infra.dataSourcesPath,
      auditPath: infra.auditPath,
      now,
      password: () => randomUUID().replace(/-/g, ""),
      adminConnectionString: pgAdmin.connectionString,
      adminExecForDb: (db: string) => createAdminExecutor(connStringForDb(pgAdmin.connectionString, db)),
      serviceOps,
      onMutate: () => { try { ontologyOps.sync(); } catch { /* never fail the infra op */ } },
    });
    sessionExtraOptions.mcpServers = { infra: server };
    sessionExtraOptions.allowedTools = [...READ_TOOL_NAMES];
    sessionExtraOptions.canUseTool = makeCanUseTool({ pending, auditPath: infra.auditPath, now });
    infraPending = pending;
  }

  const ontologyServer = createOntologyServer(ontologyOps);
  sessionExtraOptions.mcpServers = { ...(sessionExtraOptions.mcpServers as object ?? {}), ontology: ontologyServer };
  sessionExtraOptions.allowedTools = [ ...((sessionExtraOptions.allowedTools as string[]) ?? []), ...ONTOLOGY_TOOL_NAMES ];

  const manager = new SessionManager({
    query: deps.query,
    model: deps.config.model,
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
    app.use("/infra", express.json(), createInfraRouter({ pending: infraPending }));
  }

  return app;
}

// Wrap the SDK's query so it matches our narrowed QueryFn signature.
const realQuery: QueryFn = (args) =>
  sdkQuery({
    ...args,
    options: { ...args.options, env: sanitizedEnv(process.env) },
  } as never);

export function main(): void {
  const config = loadConfig(process.env);
  // The SDK reads CLAUDE_CODE_OAUTH_TOKEN from the environment; it is already
  // present (loadConfig requires it), so no extra wiring is needed here.
  mkdirSync(config.workspace, { recursive: true });
  const app = buildApp({ config, query: realQuery });
  const onListen = () => {
    const bound = config.insecureDev ? "all interfaces" : "127.0.0.1";
    console.log(`rhumb agent-host listening on ${bound}:${config.port} (model ${config.model})`);
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
