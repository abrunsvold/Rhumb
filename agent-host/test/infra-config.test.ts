import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInfraConfig } from "../src/infra/config.js";
import { appendInfraAudit } from "../src/infra/audit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-infra-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadInfraConfig", () => {
  it("defaults paths under the workspace and leaves optional creds undefined", () => {
    const cfg = loadInfraConfig({ RHUMBR_WORKSPACE: "/srv/ws" });
    expect(cfg.auditPath).toBe("/srv/ws/infra-audit.jsonl");
    expect(cfg.dataSourcesPath).toBe("/srv/ws/data-sources.json");
    expect(cfg.proxmox).toBeUndefined();
    expect(cfg.pgAdmin).toBeUndefined();
  });

  it("reads proxmox + pg-admin settings when present", () => {
    const cfg = loadInfraConfig({
      RHUMBR_WORKSPACE: "/srv/ws",
      RHUMBR_PROXMOX_URL: "https://pve:8006",
      RHUMBR_PROXMOX_TOKEN_ID: "rhumbr@pve!t1",
      RHUMBR_PROXMOX_TOKEN_SECRET: "secret",
      RHUMBR_PROXMOX_NODE: "pve",
      RHUMBR_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres",
    });
    expect(cfg.proxmox).toEqual({ baseUrl: "https://pve:8006", tokenId: "rhumbr@pve!t1", tokenSecret: "secret", node: "pve" });
    expect(cfg.pgAdmin).toEqual({ connectionString: "postgres://admin:pw@pg:5432/postgres" });
  });
});

describe("appendInfraAudit", () => {
  it("appends JSONL", () => {
    const p = join(dir, "audit.jsonl");
    appendInfraAudit(p, { ts: "t", tool: "destroy_vm", input: { id: 9 }, decision: "denied" });
    expect(JSON.parse(readFileSync(p, "utf8").trim())).toMatchObject({ tool: "destroy_vm", decision: "denied" });
  });
});
