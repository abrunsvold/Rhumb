# Tailnet Identity + Zero-Entry Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual two-URL + token connection with Tailscale-native discovery, and replace opt-in shared-token auth with deny-by-default tailnet identity on both hosts.

**Architecture:** Both hosts bind loopback and sit behind `tailscale serve` (dashboard at `/`, agent at `/agent`), which injects an unspoofable `Tailscale-User-Login` header and terminates TLS. Hosts check that login against a required allowlist. Approval routes additionally require the `Sec-Rhumb-Control: 1` header, which browsers forbid page JS from setting — so agent-built surfaces can never reach them, while the client's Rust proxy always sends it. The client discovers Rhumb boxes by enumerating tailnet peers via the Tailscale CLI and probing `/.well-known/rhumb.json`.

**Tech Stack:** Node 20 + Express + Vitest + Supertest (hosts); Tauri v2 + Rust (reqwest, futures-util) + React 18 + Vitest/Testing-Library (client); bash + python3 (setup script).

**Spec:** `docs/superpowers/specs/2026-07-01-tailnet-identity-and-discovery-design.md`

## Global Constraints

- Node `>=20`, ESM (`"type": "module"`), TypeScript strict; host tests live in `<pkg>/test/*.test.ts` and run with `npm test` (vitest + supertest).
- Client TS tests live in `client/test/*.test.tsx?`; Rust tests are inline `#[cfg(test)]` modules run with `cargo test` from `client/src-tauri`.
- New env vars: `RHUMB_ALLOWED_USERS` (comma-separated tailnet logins, e.g. `anderson.brunsvold@gmail.com`), `RHUMB_INSECURE_DEV` (`"1"` enables dev mode).
- Identity header: `Tailscale-User-Login` (read case-insensitively via Express `req.get`). Shell header: `Sec-Rhumb-Control: 1`.
- Fail closed: in identity mode (dev flag unset), hosts refuse to start with an empty allowlist and bind `127.0.0.1` only.
- Dev mode (`RHUMB_INSECURE_DEV=1`) restores today's exact behavior: bind all interfaces, optional control token, no identity checks.
- The two hosts intentionally duplicate small shared files (`auth.ts`, `sse.ts` pattern) — `identity.ts` is duplicated the same way, byte-identical.
- Commit after every task with the message given in its final step.

---

### Task 1: Identity primitives in both hosts (`identity.ts`)

**Files:**
- Create: `agent-host/src/identity.ts`
- Create: `dashboard-host/src/identity.ts` (byte-identical copy)
- Test: `agent-host/test/identity.test.ts`
- Test: `dashboard-host/test/identity.test.ts` (byte-identical copy)

**Interfaces:**
- Consumes: `createControlTokenGuard` is NOT consumed here — these are new standalone primitives.
- Produces: `createIdentityGuard(allowedUsers: string[]): RequestHandler` (403 unless `Tailscale-User-Login` is in the allowlist, compared lowercased/trimmed) and `requireShellHeader(): RequestHandler` (403 unless `Sec-Rhumb-Control: 1`). Tasks 3–5 mount these.

- [ ] **Step 1: Write the failing test** (`agent-host/test/identity.test.ts`)

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/identity.test.ts`
Expected: FAIL — cannot find module `../src/identity.js`

- [ ] **Step 3: Write the implementation** (`agent-host/src/identity.ts`)

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";

// Primary auth for identity mode. `tailscale serve` injects Tailscale-User-Login
// on every proxied request and strips any caller-supplied Tailscale-* headers,
// so the header cannot be forged from the network. The hosts bind loopback in
// identity mode, so serve is the only network path in; local processes on the
// box are inside the trust boundary (they already have workspace access).
export function createIdentityGuard(allowedUsers: string[]): RequestHandler {
  const allowed = new Set(allowedUsers.map((u) => u.trim().toLowerCase()).filter(Boolean));
  return (req: Request, res: Response, next: NextFunction): void => {
    const login = req.get("tailscale-user-login")?.trim().toLowerCase() ?? "";
    if (login && allowed.has(login)) return void next();
    res.status(403).json({ error: "forbidden" });
  };
}

// Shell-only routes (write approvals, infra approvals). Browsers refuse to let
// page JavaScript set Sec-* request headers, so agent-built surface content can
// never present this header; the client's Rust proxy always sends it. Layered
// on top of the identity guard — this distinguishes the shell from a surface
// running on the same (identity-authenticated) device.
export function requireShellHeader(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.get("sec-rhumb-control") === "1") return void next();
    res.status(403).json({ error: "shell only" });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/identity.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Copy both files into dashboard-host**

```bash
cp agent-host/src/identity.ts dashboard-host/src/identity.ts
cp agent-host/test/identity.test.ts dashboard-host/test/identity.test.ts
```

- [ ] **Step 6: Run the dashboard-host copy**

Run: `cd dashboard-host && npx vitest run test/identity.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add agent-host/src/identity.ts agent-host/test/identity.test.ts dashboard-host/src/identity.ts dashboard-host/test/identity.test.ts
git commit -m "feat(hosts): tailnet identity guard and shell-header guard primitives"
```

---

### Task 2: agent-host config — allowlist, dev flag, fail closed

**Files:**
- Modify: `agent-host/src/config.ts`
- Test: `agent-host/test/config.test.ts` (append a describe block)

**Interfaces:**
- Produces: `Config` gains `allowedUsers: string[]` and `insecureDev: boolean`. `loadConfig` throws when `insecureDev` is false and `allowedUsers` is empty. Existing fields unchanged.

- [ ] **Step 1: Write the failing tests** — append to `agent-host/test/config.test.ts`:

```ts
describe("identity config", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "tok" };

  it("parses RHUMB_ALLOWED_USERS into a lowercased list", () => {
    const cfg = loadConfig({ ...base, RHUMB_ALLOWED_USERS: " Op@Example.com , second@example.com ,, " });
    expect(cfg.allowedUsers).toEqual(["op@example.com", "second@example.com"]);
    expect(cfg.insecureDev).toBe(false);
  });

  it("fails closed: throws without RHUMB_ALLOWED_USERS in identity mode", () => {
    expect(() => loadConfig({ ...base })).toThrow(/RHUMB_ALLOWED_USERS/);
  });

  it("RHUMB_INSECURE_DEV=1 permits an empty allowlist", () => {
    const cfg = loadConfig({ ...base, RHUMB_INSECURE_DEV: "1" });
    expect(cfg.insecureDev).toBe(true);
    expect(cfg.allowedUsers).toEqual([]);
  });
});
```

Note: existing tests in this file that call `loadConfig` with only `CLAUDE_CODE_OAUTH_TOKEN` will now throw. Add `RHUMB_INSECURE_DEV: "1"` to those envs in the same edit (they test unrelated fields; dev mode preserves their previous semantics).

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: FAIL — `allowedUsers` undefined / no throw

- [ ] **Step 3: Implement** — in `agent-host/src/config.ts`, extend the interface and `loadConfig`:

```ts
export interface Config {
  port: number;
  model: string;
  workspace: string;
  oauthToken: string;
  permissionMode: string;
  controlToken?: string;
  allowedUsers: string[];
  insecureDev: boolean;
}
```

Inside `loadConfig`, after the `permissionMode` block and before the `return`:

```ts
  const insecureDev = env.RHUMB_INSECURE_DEV === "1";
  const allowedUsers = (env.RHUMB_ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (!insecureDev && allowedUsers.length === 0) {
    throw new Error(
      "RHUMB_ALLOWED_USERS is required (comma-separated tailnet logins, e.g. " +
        "you@example.com). Rhumb fails closed: every request must carry an " +
        "allowlisted Tailscale identity. Set RHUMB_INSECURE_DEV=1 only for " +
        "local development without tailscale serve.",
    );
  }
```

and add `allowedUsers, insecureDev,` to the returned object.

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/config.ts agent-host/test/config.test.ts
git commit -m "feat(agent-host): allowlist + insecure-dev config, fail closed without allowlist"
```

---

### Task 3: agent-host server — /agent prefix strip, identity + shell guards, loopback bind

**Files:**
- Modify: `agent-host/src/server.ts`
- Modify: `agent-host/src/index.ts` (buildApp deps + main bind/logs)
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `createIdentityGuard`, `requireShellHeader` (Task 1); `Config.allowedUsers/insecureDev` (Task 2).
- Produces: `createServer(deps)` signature changes — `controlToken?: string` is REPLACED by `identity: { allowedUsers: string[]; insecureDev: boolean; controlToken?: string }`. Every existing route keeps its path; requests may also arrive with an `/agent` prefix (serve does not strip mount paths) and are normalized. In identity mode ALL non-healthz routes require identity + shell header (the agent host has no surface-facing routes).

- [ ] **Step 1: Update existing construction sites and write failing tests**

In `agent-host/test/server.test.ts`, mechanical updates first:
- Every `createServer({ manager: ... })` call gains `identity: { allowedUsers: [], insecureDev: true }`.
- In the `"control-token auth"` describe, replace `controlToken: token` with `identity: { allowedUsers: [], insecureDev: true, controlToken: token }` (dev mode preserves token semantics).
- In `appWithWorkspace`, replace the `extra?: { controlToken?: string }` plumbing: signature becomes `appWithWorkspace(identity?: { allowedUsers: string[]; insecureDev: boolean; controlToken?: string })` and the createServer call uses `identity: identity ?? { allowedUsers: [], insecureDev: true }`; the two `/files` auth tests pass `{ allowedUsers: [], insecureDev: true, controlToken: "sekrit" }`.

Then append the new describe:

```ts
describe("identity mode", () => {
  const identity = { allowedUsers: ["op@example.com"], insecureDev: false };
  const shellHeaders = { "Tailscale-User-Login": "op@example.com", "Sec-Rhumb-Control": "1" };

  it("rejects POST /messages without an identity header", async () => {
    const app = createServer({ manager: fakeManager([]), identity });
    expect((await request(app).post("/messages").send({ prompt: "hi" })).status).toBe(403);
  });

  it("rejects an allowlisted identity without the shell header", async () => {
    const app = createServer({ manager: fakeManager([]), identity });
    const res = await request(app).post("/messages").set("Tailscale-User-Login", "op@example.com").send({ prompt: "hi" });
    expect(res.status).toBe(403);
  });

  it("accepts an allowlisted identity with the shell header", async () => {
    const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity });
    const res = await request(app).post("/messages").set(shellHeaders).send({ prompt: "hi" });
    expect(res.status).toBe(202);
  });

  it("leaves /healthz open with no headers", async () => {
    const app = createServer({ manager: fakeManager([]), identity });
    expect((await request(app).get("/healthz")).status).toBe(200);
  });

  it("normalizes the /agent serve mount prefix", async () => {
    const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity });
    expect((await request(app).get("/agent/healthz")).status).toBe(200);
    expect((await request(app).post("/agent/messages").set(shellHeaders).send({ prompt: "hi" })).status).toBe(202);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — type error on `identity` dep / 404 on `/agent/*` routes

- [ ] **Step 3: Implement in `agent-host/src/server.ts`**

Replace the import of `createControlTokenGuard` usage and the deps type:

```ts
import { createControlTokenGuard } from "./auth.js";
import { createIdentityGuard, requireShellHeader } from "./identity.js";

export interface IdentityDeps {
  allowedUsers: string[];
  insecureDev: boolean;
  controlToken?: string;
}
```

`createServer` deps: replace `controlToken?: string;` with `identity: IdentityDeps;`.

At the very top of the app (before `/healthz`), normalize the serve mount prefix — `tailscale serve --set-path` forwards the original URI, so `/agent/messages` must become `/messages`:

```ts
  app.use((req, _res, next) => {
    if (req.url === "/agent" || req.url.startsWith("/agent/")) {
      req.url = req.url.slice("/agent".length) || "/";
    }
    next();
  });
```

Replace the single `app.use(createControlTokenGuard(deps.controlToken));` line (keep it directly after `/healthz`, before the JSON parsers, so unauthenticated bad-JSON still 401/403s first):

```ts
  // Identity mode: every route below requires an allowlisted tailnet identity
  // AND the shell header — the agent host has no surface-facing routes, so
  // everything on it is operator-shell territory. Dev mode restores the old
  // optional-control-token behavior exactly.
  if (deps.identity.insecureDev) {
    app.use(createControlTokenGuard(deps.identity.controlToken));
  } else {
    app.use(createIdentityGuard(deps.identity.allowedUsers));
    app.use(requireShellHeader());
  }
```

- [ ] **Step 4: Wire `index.ts`**

In `buildApp`, change the `createServer` call:

```ts
  const app = createServer({
    manager,
    workspace: deps.config.workspace,
    identity: {
      allowedUsers: deps.config.allowedUsers,
      insecureDev: deps.config.insecureDev,
      controlToken: deps.config.controlToken,
    },
  });
```

In `main()`, replace the `app.listen(...)` block:

```ts
  const bindHost = config.insecureDev ? "0.0.0.0" : "127.0.0.1";
  app.listen(config.port, bindHost, () => {
    console.log(`rhumb agent-host listening on ${bindHost}:${config.port} (model ${config.model})`);
    if (config.insecureDev) {
      console.warn(
        "[rhumb] WARNING: RHUMB_INSECURE_DEV=1 — identity auth is OFF and the " +
          "host binds all interfaces. Control-token auth applies only if " +
          "RHUMB_CONTROL_TOKEN is set. Never run this mode outside local development.",
      );
    } else {
      console.log(
        `[rhumb] identity mode: loopback-only, ${config.allowedUsers.length} allowed user(s); ` +
          "reachable via tailscale serve at /agent",
      );
    }
  });
```

- [ ] **Step 5: Run the full agent-host suite; fix remaining construction sites**

Run: `cd agent-host && npm test`
Expected: `test/index.smoke.test.ts` (and any other test building a `Config` literal or env) may fail on the new fields — add `allowedUsers: [], insecureDev: true` to `Config` literals and `RHUMB_INSECURE_DEV: "1"` to env objects. Then: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/server.ts agent-host/src/index.ts agent-host/test
git commit -m "feat(agent-host): identity-mode auth, /agent prefix normalization, loopback bind"
```

---

### Task 4: dashboard-host config + well-known manifest + global identity guard

**Files:**
- Modify: `dashboard-host/src/config.ts`
- Modify: `dashboard-host/src/server.ts`
- Modify: `dashboard-host/src/index.ts`
- Test: `dashboard-host/test/server-identity.test.ts` (create), `dashboard-host/test/config.test.ts` if present (else the config assertions live in the new file)

**Interfaces:**
- Consumes: `createIdentityGuard` (Task 1).
- Produces: dashboard `Config` gains `allowedUsers: string[]`, `insecureDev: boolean` (same parsing/fail-closed as Task 2, minus the OAuth requirement). `createServer` deps gain `identity: { allowedUsers: string[]; insecureDev: boolean }` and `version: string`. New route `GET /.well-known/rhumb.json` → `{ rhumb: true, version, paths: { agent: "/agent", dashboard: "/" } }`, open like `/healthz`. Everything else is identity-gated in identity mode. Task 5 consumes the same config fields for the pending guard.

- [ ] **Step 1: Write the failing tests** (`dashboard-host/test/server-identity.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { Response } from "express";
import type { RegistrySnapshot } from "../src/types.js";

function makeApp(identity: { allowedUsers: string[]; insecureDev: boolean }) {
  return createServer({
    getSnapshot: (): RegistrySnapshot => ({ surfaces: [] }),
    workspace: "/tmp/rhumb-none",
    subscribers: new Set<Response>(),
    identity,
    version: "9.9.9",
  });
}

describe("dashboard identity config", () => {
  it("fails closed without RHUMB_ALLOWED_USERS", () => {
    expect(() => loadConfig({})).toThrow(/RHUMB_ALLOWED_USERS/);
  });

  it("parses the allowlist and dev flag", () => {
    const cfg = loadConfig({ RHUMB_ALLOWED_USERS: "Op@Example.com" });
    expect(cfg.allowedUsers).toEqual(["op@example.com"]);
    expect(cfg.insecureDev).toBe(false);
    expect(loadConfig({ RHUMB_INSECURE_DEV: "1" }).insecureDev).toBe(true);
  });
});

describe("dashboard identity mode", () => {
  const app = makeApp({ allowedUsers: ["op@example.com"], insecureDev: false });

  it("serves /healthz and the well-known manifest with no headers", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
    const res = await request(app).get("/.well-known/rhumb.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rhumb: true, version: "9.9.9", paths: { agent: "/agent", dashboard: "/" } });
  });

  it("gates /registry on identity", async () => {
    expect((await request(app).get("/registry")).status).toBe(403);
    const ok = await request(app).get("/registry").set("Tailscale-User-Login", "op@example.com");
    expect(ok.status).toBe(200);
  });

  it("gates surface serving on identity", async () => {
    expect((await request(app).get("/surfaces/d1/")).status).toBe(403);
  });

  it("dev mode leaves routes open (today's behavior)", async () => {
    const dev = makeApp({ allowedUsers: [], insecureDev: true });
    expect((await request(dev).get("/registry")).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard-host && npx vitest run test/server-identity.test.ts`
Expected: FAIL — unknown `identity`/`version` deps; loadConfig does not throw

- [ ] **Step 3: Implement config** — in `dashboard-host/src/config.ts` add to the interface:

```ts
  allowedUsers: string[];
  insecureDev: boolean;
```

and in `loadConfig`, before the `return`:

```ts
  const insecureDev = env.RHUMB_INSECURE_DEV === "1";
  const allowedUsers = (env.RHUMB_ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (!insecureDev && allowedUsers.length === 0) {
    throw new Error(
      "RHUMB_ALLOWED_USERS is required (comma-separated tailnet logins). Rhumb " +
        "fails closed: every request must carry an allowlisted Tailscale identity. " +
        "Set RHUMB_INSECURE_DEV=1 only for local development without tailscale serve.",
    );
  }
```

adding `allowedUsers, insecureDev,` to the returned object.

- [ ] **Step 4: Implement server** — in `dashboard-host/src/server.ts`:

```ts
import { createIdentityGuard } from "./identity.js";
```

Deps gain:

```ts
  identity: { allowedUsers: string[]; insecureDev: boolean };
  version: string;
```

Directly after the `/healthz` route and before everything else:

```ts
  // Discovery beacon: presence + path layout only, no secrets. Open like
  // /healthz so the client can probe tailnet peers before authenticating.
  app.get("/.well-known/rhumb.json", (_req, res) => {
    res.json({ rhumb: true, version: deps.version, paths: { agent: "/agent", dashboard: "/" } });
  });

  // Identity mode gates EVERYTHING below — registry, surfaces, data, services.
  // This closes the documented scrape-a-surface-token gap: fetching a surface
  // at all now requires an allowlisted tailnet identity. Dev mode keeps the
  // routes open exactly as before.
  if (!deps.identity.insecureDev) {
    app.use(createIdentityGuard(deps.identity.allowedUsers));
  }
```

- [ ] **Step 5: Wire `index.ts`** — in `buildApp`, read the package version and pass the new deps:

```ts
import { readFileSync } from "node:fs";
```

(top of file, merging with existing imports), then in `buildApp` before `createServer`:

```ts
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
```

and add to the `createServer` call: `identity: { allowedUsers: deps.config.allowedUsers, insecureDev: deps.config.insecureDev }, version,`.

In `main()`, replace `app.listen(config.port, () => { ... })` with the loopback-bind pattern from Task 3 Step 4 (same `bindHost` logic; log line `rhumb dashboard-host listening on ${bindHost}:${config.port} (workspace ${config.workspace})`; same dev warning text, and in identity mode log `[rhumb] identity mode: loopback-only, N allowed user(s); reachable via tailscale serve at /`). Delete the old `RHUMB_CONTROL_TOKEN` warning block (Task 5 handles the pending guard).

- [ ] **Step 6: Run the full dashboard suite; fix construction sites**

Run: `cd dashboard-host && npm test`
Expected: existing tests that call `createServer`/`buildApp` fail on missing deps. Fix mechanically: every `createServer({...})` gains `identity: { allowedUsers: [], insecureDev: true }, version: "0.0.0"`; every `buildApp` config literal gains `allowedUsers: [], insecureDev: true` (the `as never` casts still compile, but add the fields so behavior is dev-mode). Then: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard-host/src dashboard-host/test
git commit -m "feat(dashboard-host): identity-mode gating, well-known discovery manifest, loopback bind"
```

---

### Task 5: dashboard-host approval plane — shell-header guard on /data/pending

**Files:**
- Modify: `dashboard-host/src/data/router.ts`
- Modify: `dashboard-host/src/index.ts` (data router deps)
- Test: `dashboard-host/test/data-pending-guard.test.ts` (create); mechanical updates in existing data tests

**Interfaces:**
- Consumes: `requireShellHeader` (Task 1), `createControlTokenGuard` (existing), config fields (Task 4).
- Produces: `DataRouterDeps.controlToken?: string` is REPLACED by `pendingGuard: RequestHandler` (Express type). `createDataRouter` mounts `deps.pendingGuard` on `/pending` instead of building its own token guard. Surfaces can still POST queries/writes (identity-gated upstream); only the approval plane needs the shell header.

- [ ] **Step 1: Write the failing test** (`dashboard-host/test/data-pending-guard.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createDataRouter } from "../src/data/router.js";
import { requireShellHeader } from "../src/identity.js";
import { PendingQueue } from "../src/data/writes.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  const queue = new PendingQueue({
    getExecutor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
    auditPath: "/tmp/rhumb-guard-audit.jsonl",
    now: () => "t",
    id: () => "p1",
  });
  app.use(
    "/data",
    createDataRouter({
      getSources: () => [],
      getExecutor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
      queue,
      trustPath: "/tmp/rhumb-guard-trust.json",
      auditPath: "/tmp/rhumb-guard-audit.jsonl",
      now: () => "t",
      pendingGuard: requireShellHeader(),
      resolveToken: () => null,
    }),
  );
  return app;
}

describe("pending approval plane", () => {
  it("rejects /data/pending without the shell header (a surface can never set Sec-*)", async () => {
    expect((await request(makeApp()).get("/data/pending")).status).toBe(403);
  });

  it("serves /data/pending with the shell header", async () => {
    const res = await request(makeApp()).get("/data/pending").set("Sec-Rhumb-Control", "1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard-host && npx vitest run test/data-pending-guard.test.ts`
Expected: FAIL — `pendingGuard` is not a known dep

- [ ] **Step 3: Implement** — in `dashboard-host/src/data/router.ts`:

- Remove `import { createControlTokenGuard } from "../auth.js";`
- Add `import type { RequestHandler } from "express";` (merge into the existing express import line).
- In `DataRouterDeps`, replace `controlToken?: string;` with `pendingGuard: RequestHandler;`.
- Replace the guard mount line with:

```ts
  // The pending-write approval control plane is shell-only: surfaces submit
  // writes (which get queued) but must never read the queue or resolve it.
  // In identity mode the guard is the Sec-Rhumb-Control shell header, which
  // browser JS cannot set; in dev mode it is the optional control token.
  router.use("/pending", deps.pendingGuard);
```

In `dashboard-host/src/index.ts`, add the imports and build the guard:

```ts
import { requireShellHeader } from "./identity.js";
import { createControlTokenGuard } from "./auth.js";
```

and in `buildApp`, replace `controlToken: deps.config.controlToken,` in the `createDataRouter` call with:

```ts
      pendingGuard: deps.config.insecureDev
        ? createControlTokenGuard(deps.config.controlToken)
        : requireShellHeader(),
```

- [ ] **Step 4: Run the full suite; fix construction sites**

Run: `cd dashboard-host && npm test`
Expected: tests constructing `createDataRouter` deps with `controlToken` fail to compile — replace with `pendingGuard: createControlTokenGuard(<same token or undefined>)` (import from `../src/auth.js`) to preserve each test's intent; `index.smoke.test.ts`'s `/data/pending` expectation keeps passing because dev-mode configs get the token guard with no token (open). Then: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src dashboard-host/test
git commit -m "feat(dashboard-host): shell-header guard on the write-approval plane"
```

---

### Task 6: client Rust — single-base config with derived hosts, shell header on proxy

**Files:**
- Modify: `client/src-tauri/src/config.rs`
- Modify: `client/src-tauri/src/lib.rs`
- Modify: `client/src-tauri/src/proxy.rs`

**Interfaces:**
- Consumes: nothing new server-side (paths default to the spec layout).
- Produces: `AppConfig` becomes `{ base_url, agent_path (default "/agent"), dashboard_path (default "/"), control_token? }` (serde camelCase: `baseUrl`, `agentPath`, `dashboardPath`, `controlToken`), with `agent_base()`/`dashboard_base()` methods. Old config files (with `agentBase`/`dashboardBase` keys) deserialize to empty `base_url` → client shows the connection screen (the intended migration). Every proxy request now carries `Sec-Rhumb-Control: 1`. Task 8's TS mirrors this shape.

- [ ] **Step 1: Write the failing Rust tests** — in `client/src-tauri/src/config.rs`, replace the existing `write_then_read_round_trips` test and add derivation tests (inside `mod tests`):

```rust
    #[test]
    fn write_then_read_round_trips() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-rt-{}", std::process::id()));
        let path = dir.join("config.json");
        let cfg = AppConfig {
            base_url: "https://box.tail1234.ts.net".into(),
            agent_path: "/agent".into(),
            dashboard_path: "/".into(),
            control_token: Some("tok".into()),
        };
        write_config(&path, &cfg).unwrap();
        assert_eq!(read_config(&path), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derives_agent_and_dashboard_bases() {
        let cfg = AppConfig {
            base_url: "https://box.ts.net/".into(),
            agent_path: "/agent".into(),
            dashboard_path: "/".into(),
            control_token: None,
        };
        assert_eq!(cfg.agent_base(), "https://box.ts.net/agent");
        assert_eq!(cfg.dashboard_base(), "https://box.ts.net");
    }

    #[test]
    fn legacy_two_url_config_reads_as_unconfigured() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-legacy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"agentBase":"http://a:8787","dashboardBase":"http://d:8788"}"#).unwrap();
        assert_eq!(read_config(&path).base_url, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_paths_default_to_spec_layout() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-defaults-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"baseUrl":"https://box.ts.net"}"#).unwrap();
        let cfg = read_config(&path);
        assert_eq!(cfg.agent_path, "/agent");
        assert_eq!(cfg.dashboard_path, "/");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client/src-tauri && cargo test config`
Expected: FAIL — unknown fields `base_url` etc.

- [ ] **Step 3: Implement the new `AppConfig`** — replace the struct in `config.rs`:

```rust
fn default_agent_path() -> String {
    "/agent".into()
}
fn default_dashboard_path() -> String {
    "/".into()
}

// One origin, two mount paths. `tailscale serve` fronts both hosts on a single
// hostname; agent_base()/dashboard_base() derive the per-host bases the proxy
// pins its requests to. Legacy configs ({agentBase, dashboardBase}) have no
// baseUrl key, deserialize to an empty base_url, and are treated as
// unconfigured — the user reconnects through the discovery picker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_agent_path")]
    pub agent_path: String,
    #[serde(default = "default_dashboard_path")]
    pub dashboard_path: String,
    // Dev-mode only (RHUMB_INSECURE_DEV hosts): optional shared secret sent as
    // a Bearer header. Identity-mode hosts ignore it. No UI field — hand-edit
    // config.json for local development.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_token: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            base_url: String::new(),
            agent_path: default_agent_path(),
            dashboard_path: default_dashboard_path(),
            control_token: None,
        }
    }
}

fn join_base(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    if p.is_empty() {
        b.to_string()
    } else if p.starts_with('/') {
        format!("{b}{p}")
    } else {
        format!("{b}/{p}")
    }
}

impl AppConfig {
    pub fn agent_base(&self) -> String {
        join_base(&self.base_url, &self.agent_path)
    }
    pub fn dashboard_base(&self) -> String {
        join_base(&self.base_url, &self.dashboard_path)
    }
}
```

(The derive list drops `Default` — it is now manual.)

- [ ] **Step 4: Update `lib.rs` and `proxy.rs`**

`lib.rs` — `set_config` validates the single base:

```rust
#[tauri::command]
fn set_config(app: tauri::AppHandle, config: config::AppConfig) -> Result<(), String> {
    if !valid_base(&config.base_url) {
        return Err("baseUrl must be an http(s) URL".into());
    }
    config::write_config(&config_path(&app), &config).map_err(|e| e.to_string())
}
```

`proxy.rs` — targets derive from the config methods, and every request carries the shell header. Replace `agent_target`/`dashboard_target` bodies:

```rust
fn agent_target(
    app: &tauri::AppHandle,
    passed: &str,
    suffix: &str,
) -> Result<(String, Option<String>), String> {
    let cfg = crate::load_config(app);
    let base = cfg.agent_base();
    if base.is_empty() || passed.trim_end_matches('/') != base {
        return Err("agent base does not match the configured host".into());
    }
    Ok((format!("{}{}", base, suffix), cfg.control_token))
}

fn dashboard_target(
    app: &tauri::AppHandle,
    passed: &str,
    suffix: &str,
) -> Result<(String, Option<String>), String> {
    let cfg = crate::load_config(app);
    let base = cfg.dashboard_base();
    if base.is_empty() || passed.trim_end_matches('/') != base {
        return Err("dashboard base does not match the configured host".into());
    }
    Ok((format!("{}{}", base, suffix), cfg.control_token))
}

// Identity-mode hosts require Sec-Rhumb-Control on shell-only routes; browsers
// forbid page JS from sending Sec-* headers, so only this proxy can. Sent on
// every request for uniformity. The bearer token applies in dev mode only.
fn shell_request(mut req: reqwest::RequestBuilder, bearer: &Option<String>) -> reqwest::RequestBuilder {
    req = req.header("Sec-Rhumb-Control", "1");
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    req
}
```

Then in every command and in `pump`, replace the pattern

```rust
    let mut req = client.get(&url);
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
```

with

```rust
    let req = shell_request(client.get(&url), &bearer);
```

(and the `client.post(&url).json(&body)` variants likewise: `let req = shell_request(client.post(&url).json(&body), &bearer);`). There are 8 sites: `pump`, `send_message`, `get_registry`, `resolve_pending`, `resolve_infra_pending`, `upload_file`, plus the three `start_*_stream` commands go through `pump`.

- [ ] **Step 5: Run Rust tests and build**

Run: `cd client/src-tauri && cargo test && cargo build`
Expected: PASS / builds clean

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src
git commit -m "feat(client): single-origin config with derived host bases and shell header"
```

---

### Task 7: client Rust — tailnet discovery module and commands

**Files:**
- Create: `client/src-tauri/src/discover.rs`
- Modify: `client/src-tauri/src/lib.rs` (module + handler registration)

**Interfaces:**
- Consumes: `reqwest`, `futures_util` (already dependencies), `tauri::async_runtime`.
- Produces: Tauri commands `discover_hosts() -> Vec<DiscoveredHost>` (`{ baseUrl, version }` camelCase) and `fetch_manifest(base_url: String) -> Result<RhumbManifest, String>` (`{ rhumb, version, paths: { agent, dashboard } }`). Task 8's TS calls both.

- [ ] **Step 1: Write the module with failing tests** (`client/src-tauri/src/discover.rs`)

```rust
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub base_url: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestPaths {
    pub agent: String,
    pub dashboard: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RhumbManifest {
    pub rhumb: bool,
    pub version: String,
    pub paths: ManifestPaths,
}

/// Candidate origins from `tailscale status --json`: every online peer's
/// MagicDNS name (trailing dot trimmed), as an https:// origin.
pub fn parse_status_origins(json: &str) -> Vec<String> {
    let v: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(peers) = v.get("Peer").and_then(Value::as_object) else {
        return Vec::new();
    };
    peers
        .values()
        .filter(|p| p.get("Online").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|p| p.get("DNSName").and_then(Value::as_str))
        .map(|d| format!("https://{}", d.trim_end_matches('.')))
        .collect()
}

/// Locate the tailscale CLI: macOS app bundle first, then common paths, then $PATH.
pub fn find_tailscale_bin() -> Option<std::path::PathBuf> {
    let candidates = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    which_tailscale()
}

fn which_tailscale() -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("which").arg("tailscale").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() { None } else { Some(path.into()) }
}

fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("reqwest client")
}

async fn probe(client: &reqwest::Client, origin: String) -> Option<DiscoveredHost> {
    let url = format!("{}/.well-known/rhumb.json", origin);
    let manifest = client.get(&url).send().await.ok()?.json::<RhumbManifest>().await.ok()?;
    if !manifest.rhumb {
        return None;
    }
    Some(DiscoveredHost { base_url: origin, version: manifest.version })
}

#[tauri::command]
pub async fn discover_hosts() -> Vec<DiscoveredHost> {
    let Some(bin) = find_tailscale_bin() else {
        return Vec::new();
    };
    let json = match tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(bin).args(["status", "--json"]).output()
    })
    .await
    {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => return Vec::new(),
    };
    let client = probe_client();
    futures_util::stream::iter(parse_status_origins(&json))
        .map(|origin| probe(&client, origin))
        .buffer_unordered(8)
        .filter_map(|h| async move { h })
        .collect()
        .await
}

#[tauri::command]
pub async fn fetch_manifest(base_url: String) -> Result<RhumbManifest, String> {
    let base = base_url.trim_end_matches('/');
    let parsed = reqwest::Url::parse(base).map_err(|_| "not a valid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("baseUrl must be http(s)".into());
    }
    let url = format!("{}/.well-known/rhumb.json", base);
    let manifest = probe_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<RhumbManifest>()
        .await
        .map_err(|_| "host answered, but not with a Rhumb manifest".to_string())?;
    if !manifest.rhumb {
        return Err("host answered, but not with a Rhumb manifest".into());
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_online_peers_and_trims_trailing_dots() {
        let json = r#"{
          "Peer": {
            "k1": { "DNSName": "box.tail1234.ts.net.", "Online": true },
            "k2": { "DNSName": "laptop.tail1234.ts.net.", "Online": false },
            "k3": { "Online": true }
          }
        }"#;
        assert_eq!(parse_status_origins(json), vec!["https://box.tail1234.ts.net".to_string()]);
    }

    #[test]
    fn tolerates_malformed_or_peerless_status() {
        assert!(parse_status_origins("not json").is_empty());
        assert!(parse_status_origins("{}").is_empty());
    }
}
```

- [ ] **Step 2: Register in `lib.rs`** — add `mod discover;` after `mod config;`, and add `discover::discover_hosts, discover::fetch_manifest,` to the `generate_handler!` list.

- [ ] **Step 3: Run tests and build**

Run: `cd client/src-tauri && cargo test discover && cargo build`
Expected: PASS (2 tests) / builds clean

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src
git commit -m "feat(client): tailnet peer discovery via tailscale CLI and manifest probe"
```

---

### Task 8: client TS — discovery picker, single-URL fallback, config plumbing

**Files:**
- Modify: `client/src/lib/tauri.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/ConnectionScreen.tsx` (rewrite)
- Test: `client/test/ConnectionScreen.test.tsx` (rewrite), `client/test/App.test.tsx` (update mocks)

**Interfaces:**
- Consumes: Tauri commands from Tasks 6–7 (`get_config`/`set_config` with the new shape, `discover_hosts`, `fetch_manifest`).
- Produces: `AppConfig = { baseUrl: string; agentPath: string; dashboardPath: string; controlToken?: string }`, helpers `agentBaseOf(c)`, `dashboardBaseOf(c)`, `discoverHosts(): Promise<DiscoveredHost[]>`, `fetchManifest(baseUrl): Promise<RhumbManifest>`. `Workspace`/`ConfirmationDialog` keep their existing `agentBase`/`dashboardBase` string props (App derives them).

- [ ] **Step 1: Update `lib/tauri.ts`** — replace the `AppConfig` interface and add the new API surface:

```ts
export interface AppConfig {
  // Single tailscale-serve origin; per-host bases derive from the manifest paths.
  baseUrl: string;
  agentPath: string;
  dashboardPath: string;
  // Dev-mode hosts only; no UI field (hand-edit config.json for local dev).
  controlToken?: string;
}

export interface DiscoveredHost {
  baseUrl: string;
  version: string;
}

export interface RhumbManifest {
  rhumb: boolean;
  version: string;
  paths: { agent: string; dashboard: string };
}

function joinBase(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/\/+$/, "");
  if (p === "") return b;
  return p.startsWith("/") ? `${b}${p}` : `${b}/${p}`;
}

export function agentBaseOf(c: AppConfig): string {
  return joinBase(c.baseUrl, c.agentPath);
}

export function dashboardBaseOf(c: AppConfig): string {
  return joinBase(c.baseUrl, c.dashboardPath);
}

export function discoverHosts(): Promise<DiscoveredHost[]> {
  return invoke<DiscoveredHost[]>("discover_hosts");
}

export function fetchManifest(baseUrl: string): Promise<RhumbManifest> {
  return invoke<RhumbManifest>("fetch_manifest", { baseUrl });
}
```

- [ ] **Step 2: Update `App.tsx`** — connected check and derived props:

```tsx
import { agentBaseOf, dashboardBaseOf, getConfig, setConfig, type AppConfig } from "./lib/tauri";
```

In the `useEffect`: `if (c.baseUrl) setConfigState(c);`
In `disconnect()`: `await setConfig({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" });`
In the render:

```tsx
  const agentBase = agentBaseOf(config);
  const dashboardBase = dashboardBaseOf(config);
  return (
    <>
      <Workspace agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={disconnect} />
      <ConfirmationDialog agentBase={agentBase} dashboardBase={dashboardBase} />
    </>
  );
```

(compute the two consts inside the final return branch, after the `if (!config)` guard).

- [ ] **Step 3: Rewrite the ConnectionScreen test** (`client/test/ConnectionScreen.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionScreen } from "../src/components/ConnectionScreen";

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>("../src/lib/tauri");
  return {
    ...actual, // keep agentBaseOf/dashboardBaseOf pure helpers
    getConfig: vi.fn().mockResolvedValue({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" }),
    setConfig: vi.fn().mockResolvedValue(undefined),
    checkHealth: vi.fn().mockResolvedValue(true),
    discoverHosts: vi.fn().mockResolvedValue([]),
    fetchManifest: vi.fn().mockResolvedValue({
      rhumb: true,
      version: "0.1.0",
      paths: { agent: "/agent", dashboard: "/" },
    }),
  };
});

import { checkHealth, setConfig, discoverHosts, fetchManifest } from "../src/lib/tauri";

const CFG = { baseUrl: "https://box.ts.net", agentPath: "/agent", dashboardPath: "/" };

describe("ConnectionScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists discovered hosts and connects on click", async () => {
    (discoverHosts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { baseUrl: "https://box.ts.net", version: "0.1.0" },
    ]);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.click(await screen.findByRole("button", { name: /connect to box\.ts\.net/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CFG));
    expect(fetchManifest).toHaveBeenCalledWith("https://box.ts.net");
    expect(checkHealth).toHaveBeenCalledWith("https://box.ts.net/agent");
    expect(checkHealth).toHaveBeenCalledWith("https://box.ts.net");
    expect(setConfig).toHaveBeenCalledWith(CFG);
  });

  it("falls back to manual single-URL entry when discovery finds nothing", async () => {
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await screen.findByText(/no rhumb servers found/i);
    await userEvent.type(screen.getByLabelText(/server url/i), "https://box.ts.net{Enter}");
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CFG));
  });

  it("shows an error when the manifest probe fails", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockRejectedValueOnce("no manifest");
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(await screen.findByLabelText(/server url/i), "https://nope.ts.net{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/no rhumb server answered/i);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("shows an error when a health check fails", async () => {
    (checkHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(await screen.findByLabelText(/server url/i), "https://box.ts.net{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach/i);
    expect(onConnected).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd client && npx vitest run test/ConnectionScreen.test.tsx`
Expected: FAIL — old two-field UI

- [ ] **Step 5: Rewrite `ConnectionScreen.tsx`**

```tsx
import { useEffect, useState } from "react";
import {
  agentBaseOf,
  checkHealth,
  dashboardBaseOf,
  discoverHosts,
  fetchManifest,
  setConfig,
  type AppConfig,
  type DiscoveredHost,
} from "../lib/tauri";

export function ConnectionScreen({ onConnected }: { onConnected: (c: AppConfig) => void }) {
  const [found, setFound] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(true);
  const [manualUrl, setManualUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function scan() {
    setScanning(true);
    try {
      setFound(await discoverHosts());
    } catch {
      setFound([]);
    }
    setScanning(false);
  }

  useEffect(() => {
    void scan();
  }, []);

  async function connect(rawUrl: string) {
    setBusy(true);
    setError(null);
    const baseUrl = rawUrl.trim().replace(/\/+$/, "");
    try {
      const manifest = await fetchManifest(baseUrl);
      const cfg: AppConfig = {
        baseUrl,
        agentPath: manifest.paths.agent,
        dashboardPath: manifest.paths.dashboard,
      };
      const [agentOk, dashOk] = await Promise.all([
        checkHealth(agentBaseOf(cfg)),
        checkHealth(dashboardBaseOf(cfg)),
      ]);
      if (!agentOk || !dashOk) {
        setError(`Could not reach ${!agentOk ? "the agent host" : "the dashboard host"}.`);
        return;
      }
      await setConfig(cfg);
      onConnected(cfg);
    } catch {
      setError(`No Rhumb server answered at ${baseUrl}. Is \`rhumb setup\` done on the box?`);
    } finally {
      setBusy(false);
    }
  }

  const hostname = (url: string) => url.replace(/^https?:\/\//, "");

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[26rem] rounded-lg border border-line bg-panel p-6 flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Connect Rhumb</h1>
        <p className="text-xs text-muted -mt-2">
          {scanning ? "Scanning your tailnet for Rhumb servers…" : found.length > 0 ? "Found on your tailnet:" : "No Rhumb servers found on your tailnet."}
        </p>
        {found.map((h) => (
          <button
            key={h.baseUrl}
            type="button"
            disabled={busy}
            onClick={() => void connect(h.baseUrl)}
            aria-label={`Connect to ${hostname(h.baseUrl)}`}
            className="flex items-center justify-between rounded border border-line bg-raised px-3 py-2 text-left hover:border-accent disabled:opacity-40"
          >
            <span className="font-mono text-sm">{hostname(h.baseUrl)}</span>
            <span className="text-xs text-muted">v{h.version}</span>
          </button>
        ))}
        {!scanning && (
          <button type="button" onClick={() => void scan()} className="self-start text-xs text-muted underline">
            Rescan
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manualUrl.trim()) void connect(manualUrl);
          }}
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          <label htmlFor="server" className="text-xs text-muted">
            Server URL
          </label>
          <input
            id="server"
            placeholder="https://box.your-tailnet.ts.net"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || manualUrl.trim() === ""}
            className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        {error && (
          <p role="alert" className="rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Update `client/test/App.test.tsx` mocks** — wherever the mock config uses `{ agentBase, dashboardBase }`, switch to the new shape: connected state is `{ baseUrl: "https://box.ts.net", agentPath: "/agent", dashboardPath: "/" }`, unconfigured is `{ baseUrl: "", agentPath: "/agent", dashboardPath: "/" }`; the disconnect assertion becomes `expect(setConfig).toHaveBeenCalledWith({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" })`; mock module entries for `discoverHosts`/`fetchManifest` may be needed if App renders ConnectionScreen (`discoverHosts: vi.fn().mockResolvedValue([])`). Components asserting on `agentBase` props should expect the derived `https://box.ts.net/agent`.

- [ ] **Step 7: Run the client suite, typecheck, build**

Run: `cd client && npm test && npm run typecheck && npm run build`
Expected: PASS / clean

- [ ] **Step 8: Commit**

```bash
git add client/src client/test
git commit -m "feat(client): tailnet discovery picker and single-URL connection flow"
```

---

### Task 9: setup script + ATS exception removal

**Files:**
- Create: `scripts/setup-serve.sh`
- Modify: `client/src-tauri/Info.plist`

**Interfaces:**
- Consumes: `tailscale` CLI and `python3` on the box.
- Produces: an idempotent script printing the serve origin and suggested `RHUMB_ALLOWED_USERS`; a client with no ATS exception (HTTPS-only for remote hosts; ATS exempts localhost for dev).

- [ ] **Step 1: Write `scripts/setup-serve.sh`**

```bash
#!/usr/bin/env bash
# Rhumb one-time server setup: put both hosts behind `tailscale serve` so the
# client reaches a single HTTPS origin with Tailscale identity headers.
# Idempotent: re-running replaces the same two mounts.
set -euo pipefail

AGENT_PORT="${RHUMB_PORT:-8787}"
DASH_PORT="${RHUMB_DASHBOARD_PORT:-8788}"

command -v tailscale >/dev/null 2>&1 || {
  echo "error: tailscale CLI not found. Install Tailscale on this box first." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "error: python3 not found (needed to parse tailscale status)." >&2
  exit 1
}
tailscale status >/dev/null 2>&1 || {
  echo "error: tailscaled is not running or this box is not logged in. Run: tailscale up" >&2
  exit 1
}

# NOTE: serve keeps the original request path (no prefix stripping); the agent
# host normalizes its /agent prefix itself.
tailscale serve --bg --set-path=/agent "http://127.0.0.1:${AGENT_PORT}"
tailscale serve --bg "http://127.0.0.1:${DASH_PORT}"

STATUS_JSON="$(tailscale status --json)"
DNS_NAME="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
LOGIN="$(printf '%s' "$STATUS_JSON" | python3 -c '
import json, sys
s = json.load(sys.stdin)
users = s.get("User") or {}
uid = str(s.get("Self", {}).get("UserID", ""))
print((users.get(uid) or {}).get("LoginName", ""))
')"

echo
echo "Rhumb is served at: https://${DNS_NAME}"
echo "  dashboard host  -> /"
echo "  agent host      -> /agent"
echo
echo "Set on BOTH hosts before starting them:"
echo "  RHUMB_ALLOWED_USERS=${LOGIN:-<your-tailnet-login>}"
echo
echo "If the HTTPS cert fails on first request, enable HTTPS certificates for"
echo "your tailnet: https://login.tailscale.com/admin/dns (MagicDNS + HTTPS)."
```

Then: `chmod +x scripts/setup-serve.sh`

- [ ] **Step 2: Verify script syntax**

Run: `bash -n scripts/setup-serve.sh`
Expected: no output (syntax OK). Full behavior is verified in the Task 10 manual smoke.

- [ ] **Step 3: Remove the ATS exception** — replace `client/src-tauri/Info.plist` content with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- No ATS exceptions: identity mode serves everything over tailscale-serve
	     HTTPS with publicly trusted ts.net certificates. Local development
	     against http://localhost is exempt from ATS by default. -->
</dict>
</plist>
```

- [ ] **Step 4: Confirm the client still builds**

Run: `cd client && npm run build && cd src-tauri && cargo build`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-serve.sh client/src-tauri/Info.plist
git commit -m "feat(server): tailscale-serve setup script; drop client ATS exception"
```

---

### Task 10: docs — SECURITY.md, README, spec addendum; end-to-end smoke

**Files:**
- Modify: `SECURITY.md`
- Modify: `README.md` (connection/auth setup sections)
- Modify: `docs/superpowers/specs/2026-07-01-tailnet-identity-and-discovery-design.md` (addendum)

**Interfaces:** none — documentation and manual verification.

- [ ] **Step 1: Rewrite the SECURITY.md threat model.** Replace the "The hosts are unauthenticated." bullet with:

```markdown
- **Hosts authenticate every request against a Tailscale identity allowlist.**
  In the default (identity) mode both hosts bind loopback only and are fronted
  by `tailscale serve`, which terminates TLS and injects an unforgeable
  `Tailscale-User-Login` header (serve strips any caller-supplied
  `Tailscale-*` headers). Requests from logins not in `RHUMB_ALLOWED_USERS`
  are rejected; hosts refuse to start with an empty allowlist. Processes
  already running on the box can reach loopback directly and are inside the
  trust boundary — unchanged from before, since they already have workspace
  and credential access. `RHUMB_INSECURE_DEV=1` disables all of this for
  local development only.
```

Replace the "Surface data authorization" section body with:

```markdown
Serving a surface at all now requires an allowlisted tailnet identity, so the
per-surface token can no longer be scraped by arbitrary tailnet devices. The
token still identifies *which* surface is calling `/data/*` (scoping + audit).
The dangerous *actions* — approving pending writes and infrastructure
operations — additionally require the `Sec-Rhumb-Control: 1` request header.
Browsers forbid page JavaScript from setting `Sec-*` headers, so agent-built
surface content cannot present it; only the desktop client's Rust proxy does.
This replaces the optional `RHUMB_CONTROL_TOKEN` as the shell/surface
boundary (the token now applies only in `RHUMB_INSECURE_DEV=1` mode).
```

Update the "Desktop client webview posture" section: note the ATS exception has been removed because identity mode serves surfaces over tailscale-serve HTTPS, and update "Known hardening gaps" to drop the control-token-optional gap.

- [ ] **Step 2: Update README** — in the setup/run section, document the new flow: run `scripts/setup-serve.sh` on the box, set `RHUMB_ALLOWED_USERS` on both hosts, start them (loopback), launch the client and pick the discovered box; document `RHUMB_INSECURE_DEV=1` for local development. Remove instructions to enter two host URLs and a control token.

- [ ] **Step 3: Append the spec addendum** — add at the end of `docs/superpowers/specs/2026-07-01-tailnet-identity-and-discovery-design.md`:

```markdown
## Addendum (2026-07-02): shell-vs-surface discrimination

Tailnet identity is per-device, and surfaces execute on the operator's device —
so identity alone cannot keep a malicious surface from calling the approval
routes. Approval routes (`/data/pending/*`, `/infra/*` — and on the agent host,
all routes) therefore additionally require the `Sec-Rhumb-Control: 1` header.
The Fetch standard forbids page JavaScript from setting `Sec-*` request
headers, so surface content can never present it; the client's Rust proxy sends
it on every request. This supersedes the spec's implication that identity alone
gates the approval plane, and removes any need for a shared secret in the
default flow.
```

- [ ] **Step 4: Full-repo verification**

Run: `(cd agent-host && npm test) && (cd dashboard-host && npm test) && (cd client && npm test && npm run typecheck) && (cd client/src-tauri && cargo test)`
Expected: all PASS

- [ ] **Step 5: Manual end-to-end smoke (requires the Proxmox box + tailnet)**

1. On the box: `scripts/setup-serve.sh`, export `RHUMB_ALLOWED_USERS=<your login>`, start both hosts; confirm each logs `identity mode: loopback-only`.
2. `curl https://box.<tailnet>.ts.net/.well-known/rhumb.json` from the laptop → manifest JSON.
3. `curl https://box.<tailnet>.ts.net/registry` from an allowlisted device → 200; `curl http://box:8788/registry` → connection refused (loopback bind).
4. Launch the client: the box appears in the picker; one click connects; send a chat turn; a surface loads over HTTPS; approve a pending write.

- [ ] **Step 6: Commit**

```bash
git add SECURITY.md README.md docs/superpowers/specs/2026-07-01-tailnet-identity-and-discovery-design.md
git commit -m "docs: identity-mode threat model, setup flow, shell-header spec addendum"
```
