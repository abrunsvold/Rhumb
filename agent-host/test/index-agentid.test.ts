import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { createMngrAgentIdResolver, buildApp } from "../src/index.js";
import { createAgentRegistry } from "../src/agents.js";
import type { Config } from "../src/config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-agentid-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeRegistry() {
  let n = 0;
  return createAgentRegistry({
    indexPath: join(dir, "agents.json"),
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => `rhumb-${++n}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

describe("createMngrAgentIdResolver (fix round 1, C1)", () => {
  it("mints exactly one principal for a brand-new session and persists it to agents.json", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const agentId = resolve(undefined);

    expect(agentId).toMatch(/^rhumb-/);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].agentId).toBe(agentId);
    expect(registry.list()[0].backend).toBe("mngr");
    expect(existsSync(join(dir, "agents.json"))).toBe(true);
  });

  it("the minted display name satisfies mngr.ts's VALID_MNGR_NAME", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    resolve(undefined);
    expect(registry.list()[0].name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("a later turn whose sessionId is the previously-bound mngr nativeId resolves back to the SAME principal, minting nothing new", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const agentId = resolve(undefined);
    // Simulates what mngr.ts's ensureAgent does once `create` succeeds and
    // resolveNativeIdByLabel confirms the mngr agent id: registry.bind.
    registry.bind(agentId, "agent-native-1");

    const secondTurnAgentId = resolve("agent-native-1");

    expect(secondTurnAgentId).toBe(agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("repeated turns on the same bound nativeId never mint a second principal", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const agentId = resolve(undefined);
    registry.bind(agentId, "agent-native-1");

    resolve("agent-native-1");
    resolve("agent-native-1");
    resolve("agent-native-1");

    expect(registry.list()).toHaveLength(1);
  });

  it("an unrecognised incoming id mints a fresh principal rather than erroring", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const first = resolve(undefined);
    const second = resolve("some-stale-or-foreign-id");
    expect(second).not.toBe(first);
    expect(registry.list()).toHaveLength(2);
  });

  it("an incoming id that is itself an existing agentId passes through unchanged", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const agentId = resolve(undefined);
    expect(resolve(agentId)).toBe(agentId);
    expect(registry.list()).toHaveLength(1);
  });
});

describe("SDK path mints nothing (fix round 1, C1 — control case)", () => {
  it("with RHUMB_AGENT_BACKEND unset (agentBackend: sdk), agents.json is never created", async () => {
    const app = buildApp({
      config: {
        port: 0,
        provider: { id: "subscription", model: "m", credentialEnv: {} },
        workspace: dir,
        permissionMode: "acceptEdits",
        allowedUsers: [],
        insecureDev: true,
        watchdogMinutes: null,
        agentBackend: "sdk",
      } as Config,
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-1" };
          yield { type: "result", result: "hi", is_error: false };
        })(),
    });

    await request(app).post("/messages").send({ prompt: "hi" });
    // /messages is fire-and-forget (server.ts calls manager.run without
    // awaiting); give the async generator a tick to drain.
    await new Promise((r) => setTimeout(r, 20));

    expect(existsSync(join(dir, "agents.json"))).toBe(false);
  });
});
