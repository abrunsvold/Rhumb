import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, assertServiceId, readManifest } from "../src/services/manifest.js";
import { loadServiceConfig } from "../src/services/config.js";

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = validateManifest({ id: "sales", type: "service", name: "Sales", start: "npm start", port: 3000 });
    expect(m).toEqual({ id: "sales", type: "service", name: "Sales", start: "npm start", port: 3000 });
  });

  it("rejects a bad id, missing start, or non-numeric port", () => {
    expect(() => validateManifest({ id: "bad id", type: "service", name: "x", start: "s", port: 1 })).toThrow(/id/);
    expect(() => validateManifest({ id: "ok", type: "service", name: "x", port: 1 })).toThrow(/start/);
    expect(() => validateManifest({ id: "ok", type: "service", name: "x", start: "s", port: 0 })).toThrow(/port/);
  });

  it("rejects a traversal id (.. or .)", () => {
    expect(() => validateManifest({ id: "..", type: "service", name: "x", start: "s", port: 1 })).toThrow(/invalid service id/);
    expect(() => validateManifest({ id: ".", type: "service", name: "x", start: "s", port: 1 })).toThrow(/invalid service id/);
  });

  it("accepts optional runtime and dataSources", () => {
    const m = validateManifest({
      id: "poller", type: "service", name: "Poller", start: "node index.js", port: 8080,
      runtime: "node", dataSources: ["printers"],
    });
    expect(m).toMatchObject({ runtime: "node", dataSources: ["printers"] });
  });

  it("accepts each valid runtime value", () => {
    for (const runtime of ["node", "python", "none"] as const) {
      expect(validateManifest({ id: "s", type: "service", name: "x", start: "s", port: 1, runtime }).runtime).toBe(runtime);
    }
  });

  it("rejects an unknown runtime", () => {
    expect(() => validateManifest({ id: "s", type: "service", name: "x", start: "s", port: 1, runtime: "ruby" })).toThrow(/runtime/);
  });

  it("rejects dataSources that is not an array of id strings", () => {
    expect(() => validateManifest({ id: "s", type: "service", name: "x", start: "s", port: 1, dataSources: "printers" })).toThrow(/dataSources/);
    expect(() => validateManifest({ id: "s", type: "service", name: "x", start: "s", port: 1, dataSources: ["bad id"] })).toThrow(/dataSources|invalid/);
  });

  it("omits runtime and dataSources when not provided (backward compatible)", () => {
    const m = validateManifest({ id: "s", type: "service", name: "x", start: "s", port: 1 });
    expect(m).not.toHaveProperty("runtime");
    expect(m).not.toHaveProperty("dataSources");
  });

  it("accepts healthPath starting with /", () => {
    const m = validateManifest({ id: "a", name: "a", start: "run", port: 3000, healthPath: "/health" });
    expect(m.healthPath).toBe("/health");
  });

  it("omits healthPath when absent", () => {
    const m = validateManifest({ id: "a", name: "a", start: "run", port: 3000 });
    expect(m.healthPath).toBeUndefined();
  });

  it("rejects healthPath not starting with / or non-string", () => {
    expect(() => validateManifest({ id: "a", name: "a", start: "run", port: 3000, healthPath: "health" }))
      .toThrow('manifest.healthPath must be a string starting with "/"');
    expect(() => validateManifest({ id: "a", name: "a", start: "run", port: 3000, healthPath: 7 }))
      .toThrow('manifest.healthPath must be a string starting with "/"');
  });
});

describe("readManifest", () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rhumb-rm-")); });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("validates the id before touching the filesystem (traversal is refused)", () => {
    // No file is created; a valid-id read would ENOENT, but a bad id must be
    // rejected by the guard first — proving validation sits at the fs boundary.
    expect(() => readManifest(ws, "../../etc")).toThrow(/invalid service id/);
    expect(() => readManifest(ws, "..")).toThrow(/invalid service id/);
  });

  it("reads and validates a manifest for a valid id", () => {
    mkdirSync(join(ws, "services", "sales"), { recursive: true });
    writeFileSync(join(ws, "services", "sales", "service.json"), JSON.stringify({ id: "sales", type: "service", name: "Sales", start: "npm start", port: 3000 }));
    expect(readManifest(ws, "sales")).toMatchObject({ id: "sales", name: "Sales", port: 3000 });
  });
});

describe("loadServiceConfig", () => {
  it("returns undefined when required fields are absent", () => {
    expect(loadServiceConfig({ RHUMB_WORKSPACE: "/srv/ws" })).toBeUndefined();
  });

  it("reads a full config", () => {
    const cfg = loadServiceConfig({
      RHUMB_WORKSPACE: "/srv/ws",
      RHUMB_DEPLOY_KEY: "/keys/id",
      RHUMB_DEPLOY_PUBKEY: "ssh-ed25519 AAAA...",
      RHUMB_LXC_TEMPLATE: "local:vztmpl/ubuntu.tar.zst",
      RHUMB_LXC_STORAGE: "local-lvm",
      RHUMB_LXC_BRIDGE: "vmbr0",
    });
    expect(cfg).toMatchObject({
      deployKeyPath: "/keys/id",
      deployPublicKey: "ssh-ed25519 AAAA...",
      ostemplate: "local:vztmpl/ubuntu.tar.zst",
      storage: "local-lvm",
      bridge: "vmbr0",
      servicesPath: "/srv/ws/services.json",
      workspace: "/srv/ws",
      nameserver: "1.1.1.1",
    });
  });

  it("respects RHUMB_LXC_NAMESERVER override", () => {
    const cfg = loadServiceConfig({
      RHUMB_WORKSPACE: "/srv/ws",
      RHUMB_DEPLOY_KEY: "/keys/id",
      RHUMB_LXC_TEMPLATE: "local:vztmpl/ubuntu.tar.zst",
      RHUMB_LXC_STORAGE: "local-lvm",
      RHUMB_LXC_BRIDGE: "vmbr0",
      RHUMB_LXC_NAMESERVER: "192.168.1.1",
    });
    expect(cfg).toMatchObject({ nameserver: "192.168.1.1" });
  });
});
