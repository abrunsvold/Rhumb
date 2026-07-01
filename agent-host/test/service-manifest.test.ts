import { describe, it, expect } from "vitest";
import { validateManifest, assertServiceId } from "../src/services/manifest.js";
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
});

describe("loadServiceConfig", () => {
  it("returns undefined when required fields are absent", () => {
    expect(loadServiceConfig({ RHUMBR_WORKSPACE: "/srv/ws" })).toBeUndefined();
  });

  it("reads a full config", () => {
    const cfg = loadServiceConfig({
      RHUMBR_WORKSPACE: "/srv/ws",
      RHUMBR_DEPLOY_KEY: "/keys/id",
      RHUMBR_DEPLOY_PUBKEY: "ssh-ed25519 AAAA...",
      RHUMBR_LXC_TEMPLATE: "local:vztmpl/ubuntu.tar.zst",
      RHUMBR_LXC_STORAGE: "local-lvm",
      RHUMBR_LXC_BRIDGE: "vmbr0",
    });
    expect(cfg).toMatchObject({
      deployKeyPath: "/keys/id",
      deployPublicKey: "ssh-ed25519 AAAA...",
      ostemplate: "local:vztmpl/ubuntu.tar.zst",
      storage: "local-lvm",
      bridge: "vmbr0",
      servicesPath: "/srv/ws/services.json",
      workspace: "/srv/ws",
    });
  });
});
