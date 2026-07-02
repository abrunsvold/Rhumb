import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { Response } from "express";
import type { RegistrySnapshot } from "../src/types.js";

function makeApp(identity: { allowedUsers: string[]; insecureDev: boolean }) {
  return createServer({
    getSnapshot: (): RegistrySnapshot => ({ surfaces: [] }),
    workspace: "/tmp/rhumb-none",
    subscribers: new Set<Response>(),
    identity,
    version: "9.9.9",
  });
}

describe("dashboard identity config", () => {
  it("fails closed without RHUMB_ALLOWED_USERS", () => {
    expect(() => loadConfig({})).toThrow(/RHUMB_ALLOWED_USERS/);
  });

  it("parses the allowlist and dev flag", () => {
    const cfg = loadConfig({ RHUMB_ALLOWED_USERS: "Op@Example.com" });
    expect(cfg.allowedUsers).toEqual(["op@example.com"]);
    expect(cfg.insecureDev).toBe(false);
    expect(loadConfig({ RHUMB_INSECURE_DEV: "1" }).insecureDev).toBe(true);
  });
});

describe("dashboard identity mode", () => {
  const app = makeApp({ allowedUsers: ["op@example.com"], insecureDev: false });

  it("serves /healthz and the well-known manifest with no headers", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
    const res = await request(app).get("/.well-known/rhumb.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rhumb: true, version: "9.9.9", paths: { agent: "/agent", dashboard: "/" } });
  });

  it("gates /registry on identity", async () => {
    expect((await request(app).get("/registry")).status).toBe(403);
    const ok = await request(app).get("/registry").set("Tailscale-User-Login", "op@example.com");
    expect(ok.status).toBe(200);
  });

  it("gates surface serving on identity", async () => {
    expect((await request(app).get("/surfaces/d1/")).status).toBe(403);
  });

  it("dev mode leaves routes open (today's behavior)", async () => {
    const dev = makeApp({ allowedUsers: [], insecureDev: true });
    expect((await request(dev).get("/registry")).status).toBe(200);
  });
});
