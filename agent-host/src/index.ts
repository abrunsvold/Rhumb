import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { SessionManager, type QueryFn } from "./sessionManager.js";
import { createServer } from "./server.js";
import { sanitizedEnv } from "./env.js";
import type { Express } from "express";

export function buildApp(deps: { config: Config; query: QueryFn }): Express {
  const manager = new SessionManager({
    query: deps.query,
    model: deps.config.model,
    workspace: deps.config.workspace,
    permissionMode: deps.config.permissionMode,
  });
  return createServer({ manager });
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
    console.log(`rhumbr agent-host listening on :${config.port} (model ${config.model})`);
  });
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
