import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServices, serviceToRegistryEntry } from "../src/services/registry.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-dsvc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("dashboard service registry", () => {
  it("loads services and maps them to registry entries", () => {
    const p = join(dir, "services.json");
    writeFileSync(p, JSON.stringify([{ id: "sales", name: "Sales", containerId: 200, host: "10.0.0.9", port: 3000, basePath: "/services/sales", status: "healthy", createdAt: "T" }]));
    const svcs = loadServices(p);
    expect(svcs).toHaveLength(1);
    expect(serviceToRegistryEntry(svcs[0])).toMatchObject({ id: "sales", title: "Sales", url: "/services/sales/", kind: "service", status: "healthy" });
  });

  it("missing/corrupt file → []", () => {
    expect(loadServices(join(dir, "missing.json"))).toEqual([]);
    writeFileSync(join(dir, "bad.json"), "not json{");
    expect(loadServices(join(dir, "bad.json"))).toEqual([]);
  });
});
