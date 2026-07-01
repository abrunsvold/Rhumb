# Rhumb Spawned Services Implementation Plan (Plan 6 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent spawn a `service` surface — a full app in its own operator-confirmed Proxmox **LXC**, deployed over SSH, run under systemd, and reverse-proxied by the dashboard host at a stable `/services/<id>/` URL that renders like a file surface.

**Architecture:** Reuse Plan 5 wholesale (scoped Proxmox token, `canUseTool` gating + pending-action queue, infra audit, generalized client dialog). Add: an `LxcClient` seam beside Plan 5's QEMU `ProxmoxClient`; an SSH `ServiceDeployer` seam (installs a `Restart=always` systemd unit); a `createServiceOps` orchestrator (create→start→await-IP→deploy→register, with rollback); four gated + two read service tools in the existing infra MCP server; and, on the dashboard host, a per-request service registry + a `/services/:id/*` reverse proxy + a liveness probe.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, `@anthropic-ai/claude-agent-sdk`, `zod`, `http-proxy-middleware`, `node:child_process` (ssh/scp), Vitest + Supertest.

## Global Constraints

- **Depends on Plan 5 being present** (branch off `feat/infra-capability` or `main` after PR #6 merges). Files `agent-host/src/infra/{types,config,server,proxmox,pending,audit}.ts` already exist and are extended here.
- **Reuse Plan 5 gating unchanged:** gated service tools are `mcp__infra__<spawn_service|stop_service|start_service|destroy_service>`; read tools are `mcp__infra__<list_services|service_status>`. Gated tools are omitted from `allowedTools` → routed through the existing `makeCanUseTool` (which gates any name in `GATED_TOOL_NAMES`); read tools are added to `allowedTools`. No change to `makeCanUseTool` logic — only `GATED_TOOLS`/`READ_TOOL_NAMES` grow.
- **Seams:** `LxcClient` (real PVE LXC API) and `SshExec` (real `ssh`/`scp`) are the only code touching Proxmox/containers; everything else depends on the interfaces and is unit-tested with fakes. Real impls are build-verified + live-verified.
- **Container = blast-radius boundary.** No raw host processes. Every gated/destructive service op requires operator confirmation + an infra audit line (reuse Plan 5).
- **Credentials host-only:** the deploy SSH **private key** path is `RHUMB_DEPLOY_KEY` (stripped from the spawned agent subprocess env by the Plan-5 `RHUMB_*` strip); the container gets only the public key.
- **Node ≥ 20, TS strict, ES modules; agent-host/dashboard-host imports use `.js`.**
- **PVE auth/format identical to Plan 5:** base `<url>/api2/json`, header `PVEAPIToken=<tokenId>=<tokenSecret>`, POST bodies form-urlencoded with explicit `String()` coercion, `Content-Type` only when a body is present, unwrap `{ data }`. `VM.*` privileges cover LXC — the Plan-5 token already authorizes containers.
- **Reverse proxy forwards the remainder path to the container root:** `/services/:id/<rest>` → `http://<host>:<port>/<rest>`; the app is told its mount point via `RHUMB_SERVICE_BASE=/services/<id>` so it emits correct asset URLs.

---

### Task 1: Service config, types, and manifest validation

**Files:**
- Create: `agent-host/src/services/types.ts`, `agent-host/src/services/config.ts`, `agent-host/src/services/manifest.ts`
- Test: `agent-host/test/service-manifest.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces (`types.ts`): `ServiceConfig`, `LxcClient`, `LxcSpec`, `SshExec`, `SshTarget`, `ServiceDeployer`, `ServiceManifest`, `ServiceEntry`, `GatedServiceTool`.
- Produces (`config.ts`): `loadServiceConfig(env): ServiceConfig | undefined` (undefined when required fields absent; never throws).
- Produces (`manifest.ts`): `validateManifest(raw: unknown): ServiceManifest` (throws on invalid).

- [ ] **Step 1: Create `agent-host/src/services/types.ts`**

```typescript
export interface ServiceConfig {
  deployKeyPath: string;            // RHUMB_DEPLOY_KEY (private key, host-only)
  deployPublicKey: string;          // contents of RHUMB_DEPLOY_PUBKEY or <deployKeyPath>.pub
  ostemplate: string;               // e.g. "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
  storage: string;                  // e.g. "local-lvm"
  bridge: string;                   // e.g. "vmbr0"
  rootfsGb: number;                 // e.g. 8
  servicesPath: string;             // <workspace>/services.json
  workspace: string;                // <workspace> (service dirs live at <workspace>/services/<id>)
}

export interface LxcSpec {
  name: string;
  cores: number;
  memory: number;
  ostemplate: string;
  storage: string;
  bridge: string;
  rootfsGb: number;
  sshPublicKey: string;
}

export interface LxcClient {
  create(spec: LxcSpec): Promise<{ id: number }>;
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  destroy(id: number): Promise<void>;
  status(id: number): Promise<{ id: number; status: string }>;
  ip(id: number): Promise<string | null>;
}

export interface SshTarget { host: string; user: string; privateKeyPath: string }

export interface SshExec {
  run(target: SshTarget, command: string): Promise<{ stdout: string; stderr: string }>;
  pushDir(target: SshTarget, localDir: string, remoteDir: string): Promise<void>;
}

export interface ServiceManifest {
  id: string;
  type: "service";
  name: string;
  start: string;
  port: number;
  resources?: { cores?: number; memory?: number };
}

export interface ServiceDeployer {
  deploy(target: SshTarget, localDir: string, manifest: ServiceManifest): Promise<void>;
}

export interface ServiceEntry {
  id: string;
  name: string;
  containerId: number;
  host: string;
  port: number;
  basePath: string;                 // /services/<id>
  status: "healthy" | "unhealthy" | "starting";
  createdAt: string;
}

export type GatedServiceTool = "spawn_service" | "stop_service" | "start_service" | "destroy_service";
```

- [ ] **Step 2: Write the failing test** — `agent-host/test/service-manifest.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { validateManifest } from "../src/services/manifest.js";
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
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd agent-host && npx vitest run test/service-manifest.test.ts`
Expected: FAIL — cannot resolve `../src/services/manifest.js`.

- [ ] **Step 4: Create `agent-host/src/services/manifest.ts`**

```typescript
import type { ServiceManifest } from "./types.js";

const ID = /^[A-Za-z0-9._-]+$/;

export function validateManifest(raw: unknown): ServiceManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("manifest must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) throw new Error(`invalid service id: ${String(r.id)}`);
  if (typeof r.name !== "string" || r.name.length === 0) throw new Error("manifest.name is required");
  if (typeof r.start !== "string" || r.start.length === 0) throw new Error("manifest.start is required");
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
    throw new Error("manifest.port must be an integer 1-65535");
  }
  const out: ServiceManifest = { id: r.id, type: "service", name: r.name, start: r.start, port: r.port };
  if (r.resources && typeof r.resources === "object") {
    const res = r.resources as Record<string, unknown>;
    out.resources = {};
    if (typeof res.cores === "number") out.resources.cores = res.cores;
    if (typeof res.memory === "number") out.resources.memory = res.memory;
  }
  return out;
}
```

- [ ] **Step 5: Create `agent-host/src/services/config.ts`**

```typescript
import { readFileSync } from "node:fs";
import type { ServiceConfig } from "./types.js";

export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig | undefined {
  const deployKeyPath = env.RHUMB_DEPLOY_KEY?.trim();
  const ostemplate = env.RHUMB_LXC_TEMPLATE?.trim();
  const storage = env.RHUMB_LXC_STORAGE?.trim();
  const bridge = env.RHUMB_LXC_BRIDGE?.trim();
  if (!deployKeyPath || !ostemplate || !storage || !bridge) return undefined;

  let deployPublicKey = env.RHUMB_DEPLOY_PUBKEY?.trim() ?? "";
  if (!deployPublicKey) {
    try { deployPublicKey = readFileSync(`${deployKeyPath}.pub`, "utf8").trim(); } catch { deployPublicKey = ""; }
  }
  const workspace = env.RHUMB_WORKSPACE?.trim() || "./workspace";
  return {
    deployKeyPath,
    deployPublicKey,
    ostemplate,
    storage,
    bridge,
    rootfsGb: Number.parseInt(env.RHUMB_LXC_ROOTFS_GB ?? "", 10) || 8,
    servicesPath: env.RHUMB_SERVICES?.trim() || `${workspace}/services.json`,
    workspace,
  };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd agent-host && npx vitest run test/service-manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add agent-host/src/services/types.ts agent-host/src/services/config.ts agent-host/src/services/manifest.ts agent-host/test/service-manifest.test.ts
git commit -m "feat(agent-host): service config, types, and manifest validation"
```

---

### Task 2: SSH deployer (systemd-unit deploy logic)

**Files:**
- Create: `agent-host/src/services/deployer.ts`
- Test: `agent-host/test/service-deployer.test.ts`

**Interfaces:**
- Consumes: `SshExec`, `SshTarget`, `ServiceManifest`, `ServiceDeployer` (Task 1).
- Produces: `createDeployer(exec: SshExec): ServiceDeployer` — pushes `localDir` to `/opt/rhumb/<id>` and installs+enables a `Restart=always` systemd unit `rhumb-<id>.service` with `PORT` and `RHUMB_SERVICE_BASE` env, running `manifest.start` in that dir.

The deploy *logic* (push target, unit contents, enable command, injected env) is unit-tested with a fake `SshExec`. The real `SshExec` (child_process ssh/scp) is built in Task 4 and build-verified.

- [ ] **Step 1: Write the failing test** — `agent-host/test/service-deployer.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { createDeployer } from "../src/services/deployer.js";
import type { SshExec, SshTarget } from "../src/services/types.js";

function fakeExec() {
  const runs: string[] = [];
  const pushes: Array<{ localDir: string; remoteDir: string }> = [];
  const exec: SshExec = {
    async run(_t: SshTarget, command: string) { runs.push(command); return { stdout: "", stderr: "" }; },
    async pushDir(_t: SshTarget, localDir: string, remoteDir: string) { pushes.push({ localDir, remoteDir }); },
  };
  return { exec, runs, pushes };
}

const target: SshTarget = { host: "10.0.0.5", user: "root", privateKeyPath: "/k" };
const manifest = { id: "sales", type: "service" as const, name: "Sales", start: "npm ci && npm start", port: 3000 };

describe("createDeployer", () => {
  it("pushes the code to /opt/rhumb/<id> then installs+enables a systemd unit", async () => {
    const { exec, runs, pushes } = fakeExec();
    await createDeployer(exec).deploy(target, "/ws/services/sales", manifest);

    expect(pushes).toEqual([{ localDir: "/ws/services/sales", remoteDir: "/opt/rhumb/sales" }]);
    const script = runs.join("\n");
    expect(script).toContain("/etc/systemd/system/rhumb-sales.service");
    expect(script).toContain("WorkingDirectory=/opt/rhumb/sales");
    expect(script).toContain("Environment=PORT=3000");
    expect(script).toContain("Environment=RHUMB_SERVICE_BASE=/services/sales");
    expect(script).toContain("Restart=always");
    expect(script).toContain("npm ci && npm start");
    expect(script).toContain("systemctl enable --now rhumb-sales.service");
    expect(script).toContain("daemon-reload");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-host && npx vitest run test/service-deployer.test.ts`
Expected: FAIL — cannot resolve `../src/services/deployer.js`.

- [ ] **Step 3: Create `agent-host/src/services/deployer.ts`**

```typescript
import type { SshExec, ServiceDeployer, ServiceManifest, SshTarget } from "./types.js";

export function createDeployer(exec: SshExec): ServiceDeployer {
  return {
    async deploy(target: SshTarget, localDir: string, manifest: ServiceManifest): Promise<void> {
      const remoteDir = `/opt/rhumb/${manifest.id}`;
      const unitPath = `/etc/systemd/system/rhumb-${manifest.id}.service`;
      await exec.run(target, `mkdir -p ${remoteDir}`);
      await exec.pushDir(target, localDir, remoteDir);
      // Heredoc the unit file. manifest.start runs via bash -lc inside the app dir.
      const unit = [
        "[Unit]",
        `Description=Rhumb service ${manifest.id}`,
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${remoteDir}`,
        `Environment=PORT=${manifest.port}`,
        `Environment=RHUMB_SERVICE_BASE=/services/${manifest.id}`,
        `ExecStart=/bin/bash -lc ${JSON.stringify(manifest.start)}`,
        "Restart=always",
        "RestartSec=2",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");
      await exec.run(target, `cat > ${unitPath} <<'RHUMB_UNIT_EOF'\n${unit}RHUMB_UNIT_EOF`);
      await exec.run(target, "systemctl daemon-reload");
      await exec.run(target, `systemctl enable --now rhumb-${manifest.id}.service`);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd agent-host && npx vitest run test/service-deployer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/services/deployer.ts agent-host/test/service-deployer.test.ts
git commit -m "feat(agent-host): SSH deployer installs a Restart=always systemd unit"
```

---

### Task 3: Service registry writer + spawn orchestrator (serviceOps)

**Files:**
- Create: `agent-host/src/services/registry.ts`, `agent-host/src/services/ops.ts`
- Test: `agent-host/test/service-ops.test.ts`

**Interfaces:**
- Consumes: `LxcClient`, `ServiceDeployer`, `ServiceConfig`, `ServiceManifest`, `ServiceEntry` (Task 1).
- Produces (`registry.ts`): `loadServices(path): ServiceEntry[]` (missing/corrupt → `[]`), `appendService(path, e): ServiceEntry[]` (dedup by id), `removeService(path, id): ServiceEntry[]`.
- Produces (`ops.ts`): `createServiceOps(deps: { lxc: LxcClient; deployer: ServiceDeployer; config: ServiceConfig; now: () => string; readManifest: (id: string) => ServiceManifest; waitForIpMs?: number; sleep?: (ms:number)=>Promise<void> })` → `{ spawn(id): Promise<ServiceEntry>; stop(id): Promise<void>; start(id): Promise<void>; destroy(id): Promise<void>; list(): ServiceEntry[]; status(id): ServiceEntry | undefined }`. `spawn` creates the LXC, awaits an IP, deploys, and registers; on any failure after create it destroys the half-created container and rethrows.

- [ ] **Step 1: Write the failing test** — `agent-host/test/service-ops.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceOps } from "../src/services/ops.js";
import { loadServices, appendService, removeService } from "../src/services/registry.js";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest } from "../src/services/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-svc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function cfg(): ServiceConfig {
  return { deployKeyPath: "/k", deployPublicKey: "pub", ostemplate: "t", storage: "s", bridge: "b", rootfsGb: 8, servicesPath: join(dir, "services.json"), workspace: dir };
}
const manifest = (id: string): ServiceManifest => ({ id, type: "service", name: id, start: "run", port: 3000 });

describe("registry", () => {
  it("append dedups by id, remove drops, corrupt→[]", () => {
    const p = join(dir, "s.json");
    const e = { id: "a", name: "a", containerId: 1, host: "h", port: 3000, basePath: "/services/a", status: "healthy" as const, createdAt: "t" };
    expect(appendService(p, e)).toHaveLength(1);
    expect(appendService(p, e)).toHaveLength(1);
    expect(removeService(p, "a")).toHaveLength(0);
    expect(loadServices(join(dir, "missing.json"))).toEqual([]);
  });
});

describe("createServiceOps.spawn", () => {
  function fakes(overrides: Partial<LxcClient> = {}) {
    const calls: string[] = [];
    const lxc: LxcClient = {
      async create(s) { calls.push(`create:${s.name}`); return { id: 200 }; },
      async start(id) { calls.push(`start:${id}`); },
      async stop(id) { calls.push(`stop:${id}`); },
      async destroy(id) { calls.push(`destroy:${id}`); },
      async status(id) { return { id, status: "running" }; },
      async ip() { return "10.0.0.9"; },
      ...overrides,
    };
    const deployed: string[] = [];
    const deployer: ServiceDeployer = { async deploy(_t, dirArg, m) { deployed.push(`${m.id}@${dirArg}`); } };
    return { calls, deployer, deployed, lxc };
  }

  it("creates, awaits IP, deploys, and registers", async () => {
    const { calls, deployer, deployed, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    const entry = await ops.spawn("sales");
    expect(entry).toMatchObject({ id: "sales", containerId: 200, host: "10.0.0.9", port: 3000, basePath: "/services/sales", status: "healthy" });
    expect(calls).toEqual(["create:sales", "start:200"]);
    expect(deployed).toEqual([`sales@${join(dir, "services", "sales")}`]);
    expect(loadServices(cfg().servicesPath).map((s) => s.id)).toEqual(["sales"]);
  });

  it("rolls back (destroys the container) if deploy fails", async () => {
    const { calls, lxc } = fakes();
    const badDeployer: ServiceDeployer = { async deploy() { throw new Error("scp failed"); } };
    const ops = createServiceOps({ lxc, deployer: badDeployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    await expect(ops.spawn("sales")).rejects.toThrow(/scp failed/);
    expect(calls).toContain("destroy:200");
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });

  it("destroy stops+destroys the container and deregisters", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    await ops.spawn("sales");
    await ops.destroy("sales");
    expect(calls).toContain("destroy:200");
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-host && npx vitest run test/service-ops.test.ts`
Expected: FAIL — cannot resolve `../src/services/registry.js`.

- [ ] **Step 3: Create `agent-host/src/services/registry.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServiceEntry } from "./types.js";

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function write(path: string, list: ServiceEntry[]): ServiceEntry[] {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
  return list;
}

export function appendService(path: string, entry: ServiceEntry): ServiceEntry[] {
  const cur = loadServices(path);
  if (cur.some((s) => s.id === entry.id)) return cur;
  return write(path, [...cur, entry]);
}

export function removeService(path: string, id: string): ServiceEntry[] {
  return write(path, loadServices(path).filter((s) => s.id !== id));
}
```

- [ ] **Step 4: Create `agent-host/src/services/ops.ts`**

```typescript
import { join } from "node:path";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest, ServiceEntry } from "./types.js";
import { loadServices, appendService, removeService } from "./registry.js";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ServiceOps {
  spawn(id: string): Promise<ServiceEntry>;
  stop(id: string): Promise<void>;
  start(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  list(): ServiceEntry[];
  status(id: string): ServiceEntry | undefined;
}

export function createServiceOps(deps: {
  lxc: LxcClient;
  deployer: ServiceDeployer;
  config: ServiceConfig;
  now: () => string;
  readManifest: (id: string) => ServiceManifest;
  waitForIpMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ServiceOps {
  const { lxc, deployer, config, now } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const waitForIpMs = deps.waitForIpMs ?? 60_000;

  function entryFor(id: string): ServiceEntry | undefined {
    return loadServices(config.servicesPath).find((s) => s.id === id);
  }

  return {
    async spawn(id: string): Promise<ServiceEntry> {
      const manifest = deps.readManifest(id);
      const spec = {
        name: `rhumb-${manifest.id}`,
        cores: manifest.resources?.cores ?? 1,
        memory: manifest.resources?.memory ?? 512,
        ostemplate: config.ostemplate,
        storage: config.storage,
        bridge: config.bridge,
        rootfsGb: config.rootfsGb,
        sshPublicKey: config.deployPublicKey,
      };
      const { id: containerId } = await lxc.create(spec);
      try {
        await lxc.start(containerId);
        let host: string | null = null;
        const deadline = Date.now() + waitForIpMs;
        while (host === null && Date.now() < deadline) {
          host = await lxc.ip(containerId);
          if (host === null) await sleep(2000);
        }
        if (host === null) throw new Error(`container ${containerId} never reported an IP`);
        await deployer.deploy(
          { host, user: "root", privateKeyPath: config.deployKeyPath },
          join(config.workspace, "services", manifest.id),
          manifest,
        );
        const entry: ServiceEntry = {
          id: manifest.id, name: manifest.name, containerId, host, port: manifest.port,
          basePath: `/services/${manifest.id}`, status: "healthy", createdAt: now(),
        };
        appendService(config.servicesPath, entry);
        return entry;
      } catch (e) {
        try { await lxc.destroy(containerId); } catch { /* best-effort rollback */ }
        throw e;
      }
    },
    async stop(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      await lxc.stop(e.containerId);
    },
    async start(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      await lxc.start(e.containerId);
    },
    async destroy(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      try { await lxc.stop(e.containerId); } catch { /* may already be stopped */ }
      await lxc.destroy(e.containerId);
      removeService(config.servicesPath, id);
    },
    list(): ServiceEntry[] { return loadServices(config.servicesPath); },
    status(id: string): ServiceEntry | undefined { return entryFor(id); },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd agent-host && npx vitest run test/service-ops.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/services/registry.ts agent-host/src/services/ops.ts agent-host/test/service-ops.test.ts
git commit -m "feat(agent-host): service registry writer and spawn orchestrator with rollback"
```

---

### Task 4: LXC client (real seam) + service tools in the infra MCP server

**Files:**
- Create: `agent-host/src/services/lxc.ts`, `agent-host/src/services/ssh.ts`
- Modify: `agent-host/src/infra/server.ts`
- Test: `agent-host/test/infra-server.test.ts` (extend)

**Interfaces:**
- Consumes: `LxcClient`, `SshExec`, `ServiceConfig`, `ServiceOps` (Tasks 1, 3), `InfraDeps`/`GATED_TOOLS`/`READ_TOOL_NAMES` (Plan 5).
- Produces: `createLxcClient(cfg: NonNullable<InfraConfig["proxmox"]>): LxcClient` (real PVE LXC API, build-verified), `createSshExec(): SshExec` (child_process ssh/scp, build-verified). `GATED_TOOLS`/`READ_TOOL_NAMES` extended; `InfraDeps` gains optional `serviceOps?: ServiceOps`; `createInfraServer` registers the six service tools (gated ones call `deps.serviceOps`).

- [ ] **Step 1: Extend the gating list test** in `agent-host/test/infra-server.test.ts` — replace the `GATED_TOOLS` assertion so it expects the service tools too:

```typescript
  it("GATED_TOOLS includes VM and service destructive/provisioning tools", () => {
    expect([...GATED_TOOLS].sort()).toEqual(
      ["create_vm", "destroy_service", "destroy_vm", "provision_database", "resize_vm", "spawn_service", "start_service", "start_vm", "stop_service", "stop_vm"].sort(),
    );
  });
```

Also add a gating test proving a service tool routes through the pending queue exactly like a VM tool:

```typescript
  it("gates spawn_service through the pending queue", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const canUse = makeCanUseTool({ pending, auditPath: join(dir, "a.jsonl"), now: () => "T" });
    const promise = canUse("mcp__infra__spawn_service", { id: "sales" }, {} as never);
    expect(pending.list().map((p) => p.tool)).toEqual(["spawn_service"]);
    pending.resolve("a1", "approve");
    expect((await promise).behavior).toBe("allow");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts`
Expected: FAIL — `GATED_TOOLS` doesn't yet include the service tools; `PendingAction.tool` type doesn't include them.

- [ ] **Step 3: Extend `agent-host/src/infra/types.ts`** — widen `GatedTool`:

```typescript
export type GatedTool =
  | "create_vm" | "start_vm" | "stop_vm" | "resize_vm" | "destroy_vm" | "provision_database"
  | "spawn_service" | "stop_service" | "start_service" | "destroy_service";
```

- [ ] **Step 4: Extend `agent-host/src/infra/server.ts`** — grow the constants, `InfraDeps`, and the tool list. Add the import and the service tools; leave `makeCanUseTool` untouched.

```typescript
// add near the top imports:
import type { ServiceOps } from "../services/ops.js";

// replace the GATED_TOOLS / READ_TOOL_NAMES constants:
export const GATED_TOOLS: readonly GatedTool[] = [
  "create_vm", "start_vm", "stop_vm", "resize_vm", "destroy_vm", "provision_database",
  "spawn_service", "stop_service", "start_service", "destroy_service",
];
export const READ_TOOL_NAMES: readonly string[] = [
  "mcp__infra__list_vms", "mcp__infra__vm_status", "mcp__infra__list_services", "mcp__infra__service_status",
];

// add to InfraDeps:
//   serviceOps?: ServiceOps;

// inside createInfraServer's tools array, after the provision_database tool, add:
      tool("list_services", "List spawned services and their status", {}, async () => {
        try { return ok(JSON.stringify(deps.serviceOps ? deps.serviceOps.list() : [])); } catch (e) { return fail(String(e)); }
      }),
      tool("service_status", "Get one service's status", { id: z.string() }, async (a) => {
        try { return ok(JSON.stringify(deps.serviceOps?.status(a.id) ?? null)); } catch (e) { return fail(String(e)); }
      }),
      tool("spawn_service", "Provision an LXC, deploy the app from <workspace>/services/<id>, and register it", { id: z.string() }, async (a) => {
        try {
          if (!deps.serviceOps) return fail("services are not configured");
          const entry = await deps.serviceOps.spawn(a.id);
          return ok(`spawned service "${entry.id}" at ${entry.basePath}`);
        } catch (e) { return fail(String(e)); }
      }),
      tool("stop_service", "Stop a service's container", { id: z.string() }, async (a) => {
        try { await deps.serviceOps?.stop(a.id); return ok(`stopped ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("start_service", "Start a service's container", { id: z.string() }, async (a) => {
        try { await deps.serviceOps?.start(a.id); return ok(`started ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("destroy_service", "Stop, destroy, and deregister a service", { id: z.string() }, async (a) => {
        try { await deps.serviceOps?.destroy(a.id); return ok(`destroyed ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
```

Note: the read tools intentionally omit the 5th `annotations` argument to match the shipped `list_vms`/`vm_status` (Plan 5 dropped it because the SDK's `tool()` type declares only four parameters).

- [ ] **Step 5: Create `agent-host/src/services/lxc.ts`** (real PVE LXC client, mirrors `proxmox.ts`)

```typescript
import type { InfraConfig } from "../infra/types.js";
import type { LxcClient, LxcSpec } from "./types.js";

export function createLxcClient(cfg: NonNullable<InfraConfig["proxmox"]>): LxcClient {
  const base = `${cfg.baseUrl.replace(/\/$/, "")}/api2/json`;
  const authHeader = `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
  const node = cfg.node;

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const encoded = body
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
      : undefined;
    const headers: Record<string, string> = { Authorization: authHeader };
    if (encoded !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetch(`${base}${path}`, { method, headers, body: encoded });
    if (!res.ok) throw new Error(`proxmox-lxc ${method} ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: unknown }).data;
  }

  return {
    async create(spec: LxcSpec): Promise<{ id: number }> {
      const next = (await call("GET", "/cluster/nextid")) as number;
      await call("POST", `/nodes/${node}/lxc`, {
        vmid: next,
        ostemplate: spec.ostemplate,
        hostname: spec.name,
        cores: spec.cores,
        memory: spec.memory,
        rootfs: `${spec.storage}:${spec.rootfsGb}`,
        net0: `name=eth0,bridge=${spec.bridge},ip=dhcp`,
        "ssh-public-keys": spec.sshPublicKey,
        unprivileged: 1,
        onboot: 1,
        start: 0,
      });
      return { id: Number(next) };
    },
    async start(id) { await call("POST", `/nodes/${node}/lxc/${id}/status/start`); },
    async stop(id) { await call("POST", `/nodes/${node}/lxc/${id}/status/stop`); },
    async destroy(id) { await call("DELETE", `/nodes/${node}/lxc/${id}`); },
    async status(id) {
      const d = (await call("GET", `/nodes/${node}/lxc/${id}/status/current`)) as { status: string };
      return { id, status: d.status };
    },
    async ip(id): Promise<string | null> {
      const ifaces = (await call("GET", `/nodes/${node}/lxc/${id}/interfaces`)) as Array<{ name: string; inet?: string }>;
      const eth = ifaces.find((i) => i.name === "eth0" && i.inet) ?? ifaces.find((i) => i.inet && i.name !== "lo");
      if (!eth?.inet) return null;
      return eth.inet.split("/")[0]; // strip CIDR suffix
    },
  };
}
```

- [ ] **Step 6: Create `agent-host/src/services/ssh.ts`** (real ssh/scp exec, build-verified)

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshExec, SshTarget } from "./types.js";

const run = promisify(execFile);
const opts = (t: SshTarget) => [
  "-i", t.privateKeyPath,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
];

export function createSshExec(): SshExec {
  return {
    async run(target: SshTarget, command: string) {
      const { stdout, stderr } = await run("ssh", [...opts(target), `${target.user}@${target.host}`, command], { maxBuffer: 8 * 1024 * 1024 });
      return { stdout, stderr };
    },
    async pushDir(target: SshTarget, localDir: string, remoteDir: string) {
      // -r recursive; trailing /. copies contents into remoteDir
      await run("scp", ["-r", ...opts(target), `${localDir}/.`, `${target.user}@${target.host}:${remoteDir}`], { maxBuffer: 8 * 1024 * 1024 });
    },
  };
}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (existing gating tests + the two new ones); `tsc` clean (LXC + ssh seams build-verified).

- [ ] **Step 8: Commit**

```bash
git add agent-host/src/services/lxc.ts agent-host/src/services/ssh.ts agent-host/src/infra/server.ts agent-host/src/infra/types.ts agent-host/test/infra-server.test.ts
git commit -m "feat(agent-host): LXC client, ssh exec, and service tools in the infra MCP server"
```

---

### Task 5: Wire the service layer into the agent host

**Files:**
- Modify: `agent-host/src/index.ts`
- Test: `agent-host/test/index.smoke.test.ts` (extend)

**Interfaces:**
- Consumes: `loadServiceConfig`, `createLxcClient`, `createSshExec`, `createDeployer`, `createServiceOps`, `validateManifest`, `readFileSync` for the manifest.
- Produces: when infra + service config are present, the infra MCP server also gets `serviceOps`, and `list_services`/`service_status` are allowlisted (already in `READ_TOOL_NAMES`).

- [ ] **Step 1: Extend the infra wiring in `agent-host/src/index.ts`** — inside the block that builds the infra layer (guarded by `infra.proxmox && infra.pgAdmin`), also build the service layer when `loadServiceConfig(process.env)` is present, and pass `serviceOps` into `createInfraServer`. Add imports:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadServiceConfig } from "./services/config.js";
import { createLxcClient } from "./services/lxc.js";
import { createSshExec } from "./services/ssh.js";
import { createDeployer } from "./services/deployer.js";
import { createServiceOps } from "./services/ops.js";
import { validateManifest } from "./services/manifest.js";
```

Then, where `createInfraServer({ ... })` is constructed, build `serviceOps` first and include it:

```typescript
  const svcCfg = loadServiceConfig(process.env);
  const serviceOps = svcCfg
    ? createServiceOps({
        lxc: createLxcClient(infra.proxmox),
        deployer: createDeployer(createSshExec()),
        config: svcCfg,
        now,
        readManifest: (id) =>
          validateManifest(JSON.parse(readFileSync(join(svcCfg.workspace, "services", id, "service.json"), "utf8"))),
      })
    : undefined;

  const server = createInfraServer({
    proxmox: createProxmoxClient(infra.proxmox),
    admin: createAdminExecutor(infra.pgAdmin.connectionString),
    dataSourcesPath: infra.dataSourcesPath,
    auditPath: infra.auditPath,
    now,
    password: () => randomUUID().replace(/-/g, ""),
    adminConnectionString: infra.pgAdmin.connectionString,
    serviceOps,
  });
```

(`READ_TOOL_NAMES` already contains the two service read tools, so `sessionExtraOptions.allowedTools = [...READ_TOOL_NAMES]` needs no change.)

- [ ] **Step 2: Extend the smoke test** in `agent-host/test/index.smoke.test.ts` — the host still boots without service config (common path). Since the existing "does not mount /infra without proxmox+pg-admin config" test already proves the guarded path, add a lighter assertion that `buildApp` with no service env still returns a working app:

```typescript
  it("boots without service config (service tools inert)", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace" } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 3: Full agent-host suite + typecheck**

Run: `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add agent-host/src/index.ts agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): wire the service layer (lxc, deployer, serviceOps) into the infra server"
```

---

### Task 6: Dashboard host — service registry + registry-snapshot integration

**Files:**
- Create: `dashboard-host/src/services/registry.ts`
- Modify: `dashboard-host/src/types.ts` (add `status?` to `RegistryEntry`), `dashboard-host/src/config.ts` (add `servicesPath`), `dashboard-host/src/index.ts` (merge services into the snapshot)
- Test: `dashboard-host/test/service-registry.test.ts`, `dashboard-host/test/index.smoke.test.ts` (extend)

**Interfaces:**
- Consumes: `RegistrySnapshot` (existing).
- Produces (`services/registry.ts`): `loadServices(path): ServiceEntry[]` (missing/corrupt → `[]`), `serviceToRegistryEntry(s): RegistryEntry` (`{ id, title: s.name, url: "/services/<id>/", kind: "service", created, updated, status }`).

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/service-registry.test.ts`

```typescript
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard-host && npx vitest run test/service-registry.test.ts`
Expected: FAIL — cannot resolve `../src/services/registry.js`.

- [ ] **Step 3: Add `status?` to `RegistryEntry` in `dashboard-host/src/types.ts`.** `RegistrySnapshot.surfaces` is `RegistryEntry[]` and `RegistryEntry.kind` is already `string`, so service entries (kind `"service"`) merge in with no other change — services never become `SurfaceMeta`, so leave `SurfaceMeta` untouched. Add the optional status field:

```typescript
export interface RegistryEntry {
  id: string;
  title: string;
  url: string;
  kind: string;
  created: string;
  updated: string;
  status?: string;
}
```

- [ ] **Step 4: Create `dashboard-host/src/services/registry.ts`**

```typescript
import { readFileSync, existsSync } from "node:fs";

export interface ServiceEntry {
  id: string;
  name: string;
  containerId: number;
  host: string;
  port: number;
  basePath: string;
  status: string;
  createdAt: string;
}

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function serviceToRegistryEntry(s: ServiceEntry) {
  return {
    id: s.id,
    title: s.name,
    url: `/services/${s.id}/`,
    kind: "service" as const,
    created: s.createdAt,
    updated: s.createdAt,
    status: s.status,
  };
}
```

- [ ] **Step 5: Merge services into the snapshot in `dashboard-host/src/index.ts`** — the app serves the registry via `createServer({ getSnapshot: () => current, ... })`, where `current` is surfaces only. Change the config to carry a services path and merge on read. Add to the `buildApp` deps a services path from config, then replace the `getSnapshot` argument:

```typescript
import { loadServices, serviceToRegistryEntry } from "./services/registry.js";

// servicesPath default: <workspace>/services.json (add to config.ts like dataSourcesPath — RHUMB_SERVICES)
  const servicesPath = deps.config.servicesPath;

  const app = createServer({
    getSnapshot: () => ({
      surfaces: [...current.surfaces, ...loadServices(servicesPath).map(serviceToRegistryEntry)],
    }),
    workspace: deps.config.workspace,
    subscribers,
  });
```

Add `servicesPath: env.RHUMB_SERVICES?.trim() || \`${workspace}/services.json\`` to `dashboard-host/src/config.ts`'s `Config`/`loadConfig` (mirror `dataSourcesPath`).

- [ ] **Step 6: Extend the smoke test** in `dashboard-host/test/index.smoke.test.ts` — a service added to `services.json` after startup appears in the registry:

```typescript
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
```

(The registry is served at `GET /registry` by `createServer` — confirmed in `dashboard-host/src/server.ts`.)

- [ ] **Step 7: Full dashboard-host suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add dashboard-host/src/services/registry.ts dashboard-host/src/types.ts dashboard-host/src/config.ts dashboard-host/src/index.ts dashboard-host/test/service-registry.test.ts dashboard-host/test/index.smoke.test.ts
git commit -m "feat(dashboard-host): service registry merged into the surface snapshot"
```

---

### Task 7: Dashboard host — the `/services/:id/*` reverse proxy

**Files:**
- Create: `dashboard-host/src/services/proxy.ts`
- Modify: `dashboard-host/src/index.ts` (mount the proxy)
- Test: `dashboard-host/test/service-proxy.test.ts`

**Interfaces:**
- Consumes: `loadServices` (Task 6).
- Produces: `createServiceProxy(deps: { getServices: () => ServiceEntry[] }): Router` — mounts `/:id/*` (mounted at `/services`), resolving the target per request; 404 unknown id, 502 when the upstream is unreachable; forwards the remainder path to the container root and supports WebSocket upgrade.

- [ ] **Step 1: Add the dependency**

Run: `cd dashboard-host && npm install http-proxy-middleware`
Expected: `http-proxy-middleware` added to dependencies.

- [ ] **Step 2: Write the failing test** — `dashboard-host/test/service-proxy.test.ts` (uses a real fake upstream so the proxy behavior is genuinely exercised)

```typescript
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { createServiceProxy } from "../src/services/proxy.js";

let upstream: Server | undefined;
afterEach(() => { upstream?.close(); upstream = undefined; });

function appWith(services: any[]) {
  const a = express();
  a.use("/services", createServiceProxy({ getServices: () => services }));
  return a;
}

describe("service reverse proxy", () => {
  it("proxies /services/:id/<rest> to the container root", async () => {
    await new Promise<void>((resolve) => {
      upstream = createServer((req, res) => { res.end(`upstream saw ${req.url}`); }).listen(0, resolve);
    });
    const port = (upstream!.address() as any).port;
    const res = await request(appWith([{ id: "sales", host: "127.0.0.1", port }])).get("/services/sales/api/ping");
    expect(res.status).toBe(200);
    expect(res.text).toBe("upstream saw /api/ping");
  });

  it("404 for an unknown service id", async () => {
    const res = await request(appWith([])).get("/services/nope/");
    expect(res.status).toBe(404);
  });

  it("502 when the upstream is unreachable", async () => {
    // port 1 is not listening → connection refused
    const res = await request(appWith([{ id: "dead", host: "127.0.0.1", port: 1 }])).get("/services/dead/");
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd dashboard-host && npx vitest run test/service-proxy.test.ts`
Expected: FAIL — cannot resolve `../src/services/proxy.js`.

- [ ] **Step 4: Create `dashboard-host/src/services/proxy.ts`**

```typescript
import express, { type Router, type Request, type Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { ServiceEntry } from "./registry.js";

export function createServiceProxy(deps: { getServices: () => ServiceEntry[] }): Router {
  const router = express.Router();

  router.use("/:id", (req: Request, res: Response, next) => {
    const svc = deps.getServices().find((s) => s.id === req.params.id);
    if (!svc) return void res.sendStatus(404);
    const proxy = createProxyMiddleware({
      target: `http://${svc.host}:${svc.port}`,
      changeOrigin: true,
      ws: true,
      // strip the /services/:id mount prefix so the app sees the remainder at its root
      pathRewrite: (path) => path.replace(new RegExp(`^/services/${svc.id}`), "") || "/",
      on: {
        error: (_err, _req, resu) => {
          const r = resu as Response;
          if (!r.headersSent) r.writeHead(502, { "Content-Type": "text/plain" });
          r.end("service upstream unreachable");
        },
      },
    });
    return proxy(req, res, next);
  });

  return router;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd dashboard-host && npx vitest run test/service-proxy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Mount the proxy in `dashboard-host/src/index.ts`** — after the `/data` router mount, add:

```typescript
import { createServiceProxy } from "./services/proxy.js";

  app.use("/services", createServiceProxy({ getServices: () => loadServices(servicesPath) }));
```

- [ ] **Step 7: Full dashboard-host suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add dashboard-host/src/services/proxy.ts dashboard-host/src/index.ts dashboard-host/package.json dashboard-host/package-lock.json
git commit -m "feat(dashboard-host): /services/:id/* reverse proxy to running containers"
```

---

### Task 8: Dashboard host — the liveness probe

**Files:**
- Create: `dashboard-host/src/services/probe.ts`
- Modify: `dashboard-host/src/index.ts` (start the probe)
- Test: `dashboard-host/test/service-probe.test.ts`

**Interfaces:**
- Consumes: `loadServices`, `ServiceEntry` (Task 6).
- Produces: `probeOnce(deps: { getServices; probe: (s) => Promise<boolean>; writeStatus: (id, status) => void }): Promise<void>` (pure orchestration: probe each service, write `healthy`/`unhealthy`), and `startProbe(deps, intervalMs): { stop(): void }` (a `setInterval` wrapper). The registry-status writer updates `services.json` in place.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/service-probe.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { probeOnce } from "../src/services/probe.js";

describe("probeOnce", () => {
  it("writes healthy/unhealthy per service based on the probe result", async () => {
    const services = [{ id: "up", host: "h", port: 1 }, { id: "down", host: "h", port: 2 }] as any[];
    const written: Array<[string, string]> = [];
    await probeOnce({
      getServices: () => services,
      probe: async (s) => s.id === "up",
      writeStatus: (id, status) => written.push([id, status]),
    });
    expect(written).toEqual([["up", "healthy"], ["down", "unhealthy"]]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard-host && npx vitest run test/service-probe.test.ts`
Expected: FAIL — cannot resolve `../src/services/probe.js`.

- [ ] **Step 3: Create `dashboard-host/src/services/probe.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { ServiceEntry } from "./registry.js";

export async function probeOnce(deps: {
  getServices: () => Array<Pick<ServiceEntry, "id" | "host" | "port">>;
  probe: (s: { id: string; host: string; port: number }) => Promise<boolean>;
  writeStatus: (id: string, status: "healthy" | "unhealthy") => void;
}): Promise<void> {
  for (const s of deps.getServices()) {
    const ok = await deps.probe(s);
    deps.writeStatus(s.id, ok ? "healthy" : "unhealthy");
  }
}

// Real probe: a TCP/HTTP reachability check against the container's port.
export async function tcpProbe(s: { host: string; port: number }): Promise<boolean> {
  try {
    const res = await fetch(`http://${s.host}:${s.port}/`, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch { return false; }
}

// Update a service's status in services.json in place.
export function makeStatusWriter(servicesPath: string) {
  return (id: string, status: "healthy" | "unhealthy"): void => {
    if (!existsSync(servicesPath)) return;
    let list: ServiceEntry[];
    try { const raw = JSON.parse(readFileSync(servicesPath, "utf8")); list = Array.isArray(raw) ? raw : []; } catch { return; }
    const next = list.map((s) => (s.id === id ? { ...s, status } : s));
    writeFileSync(servicesPath, JSON.stringify(next, null, 2));
  };
}

export function startProbe(
  deps: Parameters<typeof probeOnce>[0],
  intervalMs: number,
): { stop(): void } {
  const timer = setInterval(() => void probeOnce(deps), intervalMs);
  if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard-host && npx vitest run test/service-probe.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Start the probe in `dashboard-host/src/index.ts`** — in `main()` (not `buildApp`, so tests don't spawn timers), after `app.listen`, start it:

```typescript
import { startProbe, tcpProbe, makeStatusWriter } from "./services/probe.js";
import { loadServices } from "./services/registry.js";

  // in main(), after app.listen(...)
  startProbe(
    { getServices: () => loadServices(config.servicesPath), probe: tcpProbe, writeStatus: makeStatusWriter(config.servicesPath) },
    15_000,
  );
```

- [ ] **Step 6: Full dashboard-host suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard-host/src/services/probe.ts dashboard-host/src/index.ts dashboard-host/test/service-probe.test.ts
git commit -m "feat(dashboard-host): liveness probe updates service status"
```

---

## Done criteria (automated)

- `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (config/manifest/deployer/ops/gating/wiring; nothing else broken).
- `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (service registry + snapshot merge + reverse proxy + probe).
- `cd client && npx vitest run` — unchanged and green (no client changes; service surfaces reuse the registry/surface machinery and the Plan-5 confirmation dialog).

## Live verification (driver-run, against your Proxmox)

Set on the agent host (in addition to the Plan-5 infra vars): `RHUMB_DEPLOY_KEY` (path to a deploy private key; put its `.pub` in `RHUMB_DEPLOY_PUBKEY` or `<key>.pub`), `RHUMB_LXC_TEMPLATE`, `RHUMB_LXC_STORAGE`, `RHUMB_LXC_BRIDGE`. Ensure the same `RHUMB_WORKSPACE`/`RHUMB_SERVICES` on both hosts.
1. Ask the agent to "write a tiny HTTP service that returns 'hello' and spawn it as `demo-svc`." → the agent writes `<workspace>/services/demo-svc/{app,service.json}` and calls `spawn_service` → a confirmation pops → approve → an LXC is created on your PVE, the app is scp'd in and started under systemd, and `/services/demo-svc/` proxies to it (open it in the client).
2. Kill the app process inside the container → systemd restarts it (crash-restart); the liveness probe keeps status `healthy`.
3. Ask to `destroy_service demo-svc` → confirm → the LXC is destroyed and the registry entry is gone. A **denied** destroy leaves it running.
4. Confirm `list_services`/`service_status` run without a confirmation dialog (allowlisted).

## Next plan

**Plan 7 — Ontology:** an Obsidian-style markdown + wikilink knowledge graph (system layer: VMs, containers, databases, data sources, services, tasks; domain layer: the operator's entities) that records what Plans 5–6 create and gives the agent + every surface one browsable vocabulary.
