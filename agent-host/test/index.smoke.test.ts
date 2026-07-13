import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index.js";

describe("buildApp wiring", () => {
  it("builds an app whose /messages drives the injected query and streams a result", async () => {
    const app = buildApp({
      config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok", permissionMode: "acceptEdits", allowedUsers: [], insecureDev: true },
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-7" };
          yield { type: "result", result: "hello world", is_error: false };
        })(),
    });

    const health = await request(app).get("/healthz");
    expect(health.status).toBe(200);

    const posted = await request(app).post("/messages").send({ prompt: "hi" });
    expect(posted.status).toBe(202);
  });

  it("does not mount /infra without proxmox+pg-admin config", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace", allowedUsers: [], insecureDev: true } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/infra/pending");
    expect(res.status).toBe(404);
  });

  it("boots without service config (service tools inert)", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace", allowedUsers: [], insecureDev: true } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("boots with the ontology wired (no infra config required)", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace", allowedUsers: [], insecureDev: true } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("serves GET /ontology with nodes and sync status", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace", allowedUsers: [], insecureDev: true } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/ontology");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body).toHaveProperty("syncedAt");
    expect(res.body).toHaveProperty("syncError");
  });

  it("exposes no watchdog when RHUMB_WATCHDOG_MINUTES is unset", () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace", allowedUsers: [], insecureDev: true, watchdogMinutes: null } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    expect(app.locals.watchdog).toBeUndefined();
  });

  it("runs watchdog ticks as restricted read-only sessions", async () => {
    let captured: { prompt?: string; options?: Record<string, unknown> } = {};
    const app = buildApp({
      config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok", permissionMode: "acceptEdits", allowedUsers: [], insecureDev: true, watchdogMinutes: 5 } as never,
      query: (args: { prompt: string; options?: Record<string, unknown> }) => {
        captured = args;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "wd-1" };
          yield { type: "result", result: "All healthy", is_error: false };
        })();
      },
    });
    const watchdog = app.locals.watchdog as { tick: () => Promise<string> };
    expect(watchdog).toBeDefined();
    expect(await watchdog.tick()).toBe("ran");
    expect(captured.prompt).toContain("watchdog");
    const disallowed = captured.options?.disallowedTools as string[];
    expect(disallowed).toContain("Bash");
    expect(disallowed).toContain("Write");
    expect(disallowed).toContain("mcp__infra__destroy_vm");
    expect(disallowed).not.toContain("mcp__ontology__query");
  });

  it("sessions disallow AskUserQuestion and append the Rhumb system prompt", async () => {
    let captured: Record<string, unknown> | undefined;
    const app = buildApp({
      config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok", permissionMode: "acceptEdits", allowedUsers: [], insecureDev: true },
      query: (args: { options?: Record<string, unknown> }) => {
        captured = args.options;
        return (async function* () { yield { type: "result", result: "", is_error: false }; })();
      },
    });
    await request(app).post("/messages").send({ prompt: "hi" });
    for (let i = 0; i < 100 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
    expect(captured?.disallowedTools).toContain("AskUserQuestion");
    const sp = captured?.systemPrompt as { type: string; preset: string; append: string };
    expect(sp).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(sp.append).toContain("operator approval");
  });
});
