import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServices, serviceToRegistryEntry } from "../src/services/registry.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-dsvc-")); });
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

  const base = { id: "sales", name: "Sales", containerId: 200, host: "10.0.0.9", port: 3000, basePath: "/services/sales", status: "healthy", createdAt: "T" };
  const load = (entry: Record<string, unknown>) => {
    const p = join(dir, "services.json");
    writeFileSync(p, JSON.stringify([entry]));
    return loadServices(p);
  };

  it("drops an entry with an invalid id", () => {
    expect(load({ ...base, id: "../../etc" })).toEqual([]);
    expect(load({ ...base, id: "a b" })).toEqual([]);
  });

  it("drops an entry whose host is link-local (cloud metadata SSRF)", () => {
    expect(load({ ...base, host: "169.254.169.254" })).toEqual([]);
  });

  it("drops an entry whose host is loopback", () => {
    expect(load({ ...base, host: "127.0.0.1" })).toEqual([]);
    expect(load({ ...base, host: "localhost" })).toEqual([]);
    expect(load({ ...base, host: "::1" })).toEqual([]);
  });

  it("drops an entry with an out-of-range or non-numeric port", () => {
    expect(load({ ...base, port: 0 })).toEqual([]);
    expect(load({ ...base, port: 70000 })).toEqual([]);
    expect(load({ ...base, port: "3000" })).toEqual([]);
  });

  it("keeps a valid entry on a private container IP", () => {
    expect(load(base)).toHaveLength(1);
  });
});
