import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { createServer } from "../src/server.js";
import type { RegistrySnapshot } from "../src/types.js";

let workspace: string;

function writeSurface(id: string, entry = "index.html", body = "<h1>hi</h1>"): void {
  const dir = join(workspace, "surfaces", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({ id, title: id, kind: "file", entry, created: "t", updated: "t" }),
  );
  writeFileSync(join(dir, entry), body);
}

const snapshot: RegistrySnapshot = {
  surfaces: [
    { id: "d1", title: "d1", url: "/surfaces/d1/", kind: "file", created: "t", updated: "t" },
  ],
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rhumb-srv-"));
  // a secret file OUTSIDE the surface, to prove traversal is blocked
  writeFileSync(join(workspace, "secret.txt"), "TOP SECRET");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function app(snap: RegistrySnapshot = snapshot) {
  return createServer({
    getSnapshot: () => snap,
    workspace,
    subscribers: new Set<Response>(),
  });
}

describe("dashboard-host server", () => {
  it("GET /healthz returns ok", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /registry returns the current snapshot", async () => {
    const res = await request(app()).get("/registry");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
  });

  it("GET /surfaces/:id/ serves the surface entry file", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1>hi</h1>");
  });

  it("GET /surfaces/:id (no trailing slash) also serves the entry", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1>hi</h1>");
  });

  it("serves a named asset within the surface", async () => {
    writeSurface("d1");
    mkdirSync(join(workspace, "surfaces", "d1"), { recursive: true });
    writeFileSync(join(workspace, "surfaces", "d1", "app.js"), "console.log(1)");
    const res = await request(app()).get("/surfaces/d1/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log(1)");
  });

  it("blocks path traversal out of the surface folder", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1/..%2f..%2fsecret.txt");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("TOP SECRET");
  });

  it("rejects an unsafe surface id", async () => {
    const res = await request(app()).get("/surfaces/..%2f..%2fsecret.txt/");
    expect(res.status).toBe(404);
  });

  it("404s a missing surface", async () => {
    const res = await request(app()).get("/surfaces/nope/");
    expect(res.status).toBe(404);
  });

  it("does not follow a symlink that escapes the surface folder", async () => {
    writeSurface("d1");
    symlinkSync(
      join(workspace, "secret.txt"),
      join(workspace, "surfaces", "d1", "leak.txt"),
    );
    const res = await request(app()).get("/surfaces/d1/leak.txt");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("TOP SECRET");
  });
});
