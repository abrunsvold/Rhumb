import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import type { WatchFn } from "../src/watcher.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rhumbr-idx-"));
  const dir = join(workspace, "surfaces", "d1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({ id: "d1", title: "Dash One", kind: "file", entry: "index.html", created: "t", updated: "t" }),
  );
  writeFileSync(join(dir, "index.html"), "<h1>one</h1>");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("buildApp wiring", () => {
  it("serves the registry seeded by the initial watcher scan and the surface entry", async () => {
    const noopWatch: WatchFn = () => ({ close() {} });
    const app = buildApp({ config: { port: 0, workspace }, watch: noopWatch });

    const reg = await request(app).get("/registry");
    expect(reg.status).toBe(200);
    expect(reg.body.surfaces.map((s: { id: string }) => s.id)).toEqual(["d1"]);
    expect(reg.body.surfaces[0].url).toBe("/surfaces/d1/");

    const page = await request(app).get("/surfaces/d1/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<h1>one</h1>");
  });
});
