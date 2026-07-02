import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createIdentityGuard, requireShellHeader } from "../src/identity.js";

function appWith(mw: express.RequestHandler) {
  const app = express();
  app.use(mw);
  app.get("/x", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("createIdentityGuard", () => {
  const guard = createIdentityGuard(["op@example.com"]);

  it("passes an allowlisted login", async () => {
    const res = await request(appWith(guard)).get("/x").set("Tailscale-User-Login", "op@example.com");
    expect(res.status).toBe(200);
  });

  it("compares logins case-insensitively and trims whitespace", async () => {
    const res = await request(appWith(createIdentityGuard(["Op@Example.com"])))
      .get("/x")
      .set("Tailscale-User-Login", "  op@EXAMPLE.com ");
    expect(res.status).toBe(200);
  });

  it("rejects a missing header with 403", async () => {
    const res = await request(appWith(guard)).get("/x");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("rejects a non-allowlisted login with 403", async () => {
    const res = await request(appWith(guard)).get("/x").set("Tailscale-User-Login", "intruder@example.com");
    expect(res.status).toBe(403);
  });

  it("rejects everything when the allowlist is empty", async () => {
    const res = await request(appWith(createIdentityGuard([]))).get("/x").set("Tailscale-User-Login", "op@example.com");
    expect(res.status).toBe(403);
  });
});

describe("requireShellHeader", () => {
  it("passes when Sec-Rhumb-Control is 1", async () => {
    const res = await request(appWith(requireShellHeader())).get("/x").set("Sec-Rhumb-Control", "1");
    expect(res.status).toBe(200);
  });

  it("rejects when the header is absent or wrong", async () => {
    expect((await request(appWith(requireShellHeader())).get("/x")).status).toBe(403);
    expect((await request(appWith(requireShellHeader())).get("/x").set("Sec-Rhumb-Control", "0")).status).toBe(403);
  });
});
