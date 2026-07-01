import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { loadConfig, type Config } from "./config.js";
import { SessionManager, type QueryFn } from "./sessionManager.js";
import { createServer } from "./server.js";
import { sanitizedEnv } from "./env.js";
import { loadInfraConfig } from "./infra/config.js";
import { createProxmoxClient } from "./infra/proxmox.js";
import { createAdminExecutor } from "./infra/pgAdmin.js";
import { PendingActions } from "./infra/pending.js";
import { createInfraServer, makeCanUseTool, READ_TOOL_NAMES } from "./infra/server.js";
import { createInfraRouter } from "./infra/router.js";
import { loadServiceConfig } from "./services/config.js";
import { createLxcClient } from "./services/lxc.js";
import { createSshExec } from "./services/ssh.js";
import { createDeployer } from "./services/deployer.js";
import { createServiceOps } from "./services/ops.js";
import { validateManifest } from "./services/manifest.js";
import type { Express } from "express";

export function buildApp(deps: { config: Config; query: QueryFn }): Express {
  const sessionExtraOptions: Record<string, unknown> = {};
  const infra = loadInfraConfig(process.env);
  let infraPending: PendingActions | undefined;

  if (infra.proxmox && infra.pgAdmin) {
    const now = () => new Date().toISOString();
    const pending = new PendingActions({ now, id: () => randomUUID() });
    const svcCfg = loadServiceConfig(process.env);
    const serviceOps = svcCfg
      ? createServiceOps({
          lxc: createLxcClient(infra.proxmox),
          deployer: createDeployer(createSshExec()),
          config: svcCfg,
          now,
          readManifest: (id) =>
            validateManifest(JSON.parse(readFileSync(join(svcCfg.workspace, "services", id, "service.json"), "utf8"))),
        })
      : undefined;
    const server = createInfraServer({
      proxmox: createProxmoxClient(infra.proxmox),
      admin: createAdminExecutor(infra.pgAdmin.connectionString),
      dataSourcesPath: infra.dataSourcesPath,
      auditPath: infra.auditPath,
      now,
      password: () => randomUUID().replace(/-/g, ""),
      adminConnectionString: infra.pgAdmin.connectionString,
      serviceOps,
    });
    sessionExtraOptions.mcpServers = { infra: server };
    sessionExtraOptions.allowedTools = [...READ_TOOL_NAMES];
    sessionExtraOptions.canUseTool = makeCanUseTool({ pending, auditPath: infra.auditPath, now });
    infraPending = pending;
  }

  const manager = new SessionManager({
    query: deps.query,
    model: deps.config.model,
    workspace: deps.config.workspace,
    permissionMode: deps.config.permissionMode,
    extraOptions: sessionExtraOptions,
  });
  const app = createServer({ manager });

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
  app.listen(config.port, () => {
    console.log(`rhumb agent-host listening on :${config.port} (model ${config.model})`);
  });
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
