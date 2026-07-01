import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import type { WatchFn } from "../src/watcher.js";

let workspace: string;

const SURFACE_TOKEN = "smoke-test-surface-token";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rhumb-idx-"));
  const dir = join(workspace, "surfaces", "d1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({ id: "d1", title: "Dash One", kind: "file", entry: "index.html", created: "t", updated: "t" }),
  );
  writeFileSync(join(dir, "index.html"), "<h1>one</h1>");
  writeFileSync(join(dir, ".surface-token"), SURFACE_TOKEN);
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("buildApp wiring", () => {
  it("serves the registry seeded by the initial watcher scan and the surface entry", async () => {
    const noopWatch: WatchFn = () => ({ close() {} });
    const app = buildApp({
      config: {
        port: 0,
        workspace,
        dataSourcesPath: join(workspace, "data-sources.json"),
        dataTrustPath: join(workspace, "data-trust.json"),
        dataAuditPath: join(workspace, "data-audit.jsonl"),
      },
      watch: noopWatch,
    });

    const reg = await request(app).get("/registry");
    expect(reg.status).toBe(200);
    expect(reg.body.surfaces.map((s: { id: string }) => s.id)).toEqual(["d1"]);
    expect(reg.body.surfaces[0].url).toBe("/surfaces/d1/");

    const page = await request(app).get("/surfaces/d1/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<h1>one</h1>");
  });

  it("mounts the data router", async () => {
    // write a data-sources.json into the temp workspace with one source
    writeFileSync(join(workspace, "data-sources.json"), JSON.stringify([
      { id: "ops", type: "postgres", mode: "read-write", connectionString: "x" },
    ]));
    const app = buildApp({
      config: {
        port: 0,
        workspace,
        dataSourcesPath: join(workspace, "data-sources.json"),
        dataTrustPath: join(workspace, "data-trust.json"),
        dataAuditPath: join(workspace, "data-audit.jsonl"),
      } as never,
      watch: () => ({ close() {} }),
      executorFor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
    });
    const res = await request(app).get("/data/pending");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });

  it("includes a service added to services.json in the registry snapshot", async () => {
    const svcPath = join(workspace, "services.json");
    writeFileSync(svcPath, JSON.stringify([]));
    const app = buildApp({
      config: { port: 0, workspace, servicesPath: svcPath, dataSourcesPath: join(workspace, "ds.json"), dataTrustPath: join(workspace, "t.json"), dataAuditPath: join(workspace, "a.jsonl") } as never,
      watch: () => ({ close() {} }),
    });
    writeFileSync(svcPath, JSON.stringify([{ id: "sales", name: "Sales", containerId: 1, host: "h", port: 3000, basePath: "/services/sales", status: "healthy", createdAt: "T" }]));
    const res = await request(app).get("/registry");
    expect(res.body.surfaces.map((s: { id: string }) => s.id)).toContain("sales");
  });

  it("picks up a data source added to data-sources.json after startup", async () => {
    const dsPath = join(workspace, "data-sources.json");
    writeFileSync(dsPath, JSON.stringify([])); // start empty
    const app = buildApp({
      config: { port: 0, workspace, dataSourcesPath: dsPath, dataTrustPath: join(workspace, "t.json"), dataAuditPath: join(workspace, "a.jsonl") } as never,
      watch: () => ({ close() {} }),
      executorFor: () => ({ async run() { return { rows: [{ ok: 1 }], rowCount: 1 }; } }),
    });
    // not present yet and no token → 401 (auth check runs before source lookup to prevent source enumeration)
    expect((await request(app).post("/data/late/query").send({ op: { kind: "select", table: "t" } })).status).toBe(401);
    // add it
    writeFileSync(dsPath, JSON.stringify([{ id: "late", type: "postgres", mode: "read-write", connectionString: "x" }]));
    // now found — present the surface token so the auth check passes
    expect((await request(app).post("/data/late/query").set("X-Rhumb-Surface-Token", SURFACE_TOKEN).send({ op: { kind: "select", table: "t" } })).status).toBe(200);
  });
});
