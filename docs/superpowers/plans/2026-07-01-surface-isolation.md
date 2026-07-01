# Surface Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the forgeable `Referer` write-trust signal with a per-surface capability token, and constrain served surfaces with security headers, so a malicious or spoofed surface cannot forge write-trust, read data without a token, or exfiltrate data.

**Architecture:** The dashboard host mints a random token per surface (persisted in a `.surface-token` sidecar), injects a small `fetch`/XHR shim into served surface HTML that attaches the token on same-origin `/data/*` calls, and sets security headers on surface responses. The data endpoint resolves the calling surface from the token instead of `Referer`. Client (Tauri) changes keep the current iframe sandbox and lock detached surface windows out of Tauri capabilities.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` import specifiers), Express 4, Vitest + supertest. Rust/Tauri v2 for the client tasks.

## Global Constraints

- Single origin for surfaces and control/data plane (no second port). Per the spec, this is the accepted posture.
- Keep the trusted-surface **direct-write** convenience; only change the *signal* trust is keyed on (token, not `Referer`).
- Opt-in `RHUMB_CONTROL_TOKEN` already gates the approval routes — do not change that.
- ESM: every intra-package import uses a `.js` specifier (e.g. `./surfaces/token.js`).
- Token charset is URL-safe base64 (`base64url`); surface ids match `^[A-Za-z0-9._-]+$` — both are safe to embed in HTML/JSON without escaping beyond `JSON.stringify`.
- `RHUMB_APP_ORIGINS` default: `tauri://localhost https://tauri.localhost`.
- Parts A & B (dashboard) are TDD in this environment. Part C (client) is verified in the operator's Tauri dev environment; its steps use `cargo`/`npm run tauri` and manual checks, not vitest.

---

### Task 1: Per-surface token module

**Files:**
- Create: `dashboard-host/src/surfaces/token.ts`
- Test: `dashboard-host/test/surface-token.test.ts`

**Interfaces:**
- Produces:
  - `getOrCreateSurfaceToken(surfaceDir: string): string` — returns the surface's stable token, generating + persisting `<surfaceDir>/.surface-token` on first call.
  - `resolveSurfaceToken(surfacesRoot: string, token: string): string | null` — reverse lookup token → surfaceId (the directory name), or `null` if empty/unknown.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard-host/test/surface-token.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateSurfaceToken, resolveSurfaceToken } from "../src/surfaces/token.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rhumb-tok-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("surface token", () => {
  it("generates a token on first call and is stable across calls", () => {
    const dir = join(root, "d1"); mkdirSync(dir);
    const t1 = getOrCreateSurfaceToken(dir);
    const t2 = getOrCreateSurfaceToken(dir);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(t2).toBe(t1);
    expect(readFileSync(join(dir, ".surface-token"), "utf8").trim()).toBe(t1);
  });

  it("resolves a token back to its surface id, and null for unknown/empty", () => {
    const dir = join(root, "sales"); mkdirSync(dir);
    const token = getOrCreateSurfaceToken(dir);
    expect(resolveSurfaceToken(root, token)).toBe("sales");
    expect(resolveSurfaceToken(root, "nope")).toBeNull();
    expect(resolveSurfaceToken(root, "")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/surface-token.test.ts`
Expected: FAIL — cannot find module `../src/surfaces/token.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard-host/src/surfaces/token.ts
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = ".surface-token";

export function getOrCreateSurfaceToken(surfaceDir: string): string {
  const path = join(surfaceDir, TOKEN_FILE);
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t.length > 0) return t;
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token);
  return token;
}

export function resolveSurfaceToken(surfacesRoot: string, token: string): string | null {
  if (!token) return null;
  if (!existsSync(surfacesRoot)) return null;
  for (const d of readdirSync(surfacesRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const path = join(surfacesRoot, d.name, TOKEN_FILE);
    if (!existsSync(path)) continue;
    // Plain compare: the token is high-entropy and this host is tailnet-only.
    if (readFileSync(path, "utf8").trim() === token) return d.name;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/surface-token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/surfaces/token.ts dashboard-host/test/surface-token.test.ts
git commit -m "feat(dashboard-host): per-surface capability token module"
```

---

### Task 2: Shim rendering and HTML injection

**Files:**
- Create: `dashboard-host/src/surfaces/shim.ts`
- Test: `dashboard-host/test/surface-shim.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `renderShim(surfaceId: string, token: string): string` — the `<script>…</script>` (+ `<meta>`) markup to inject.
  - `injectShim(html: string, markup: string): string` — inserts `markup` immediately after the opening `<head>` tag; falls back to after `<html…>`; else prepends.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard-host/test/surface-shim.test.ts
import { describe, it, expect } from "vitest";
import { renderShim, injectShim } from "../src/surfaces/shim.js";

describe("surface shim", () => {
  it("renders a shim carrying the token and surface id", () => {
    const m = renderShim("d1", "TOK123");
    expect(m).toContain("TOK123");
    expect(m).toContain("d1");
    expect(m).toContain("X-Rhumb-Surface-Token");
    expect(m).toContain("<script>");
  });

  it("injects right after <head>", () => {
    const out = injectShim("<html><head><title>x</title></head><body></body></html>", "<!--S-->");
    expect(out).toBe("<html><head><!--S--><title>x</title></head><body></body></html>");
  });

  it("falls back to after <html> when there is no head", () => {
    expect(injectShim("<html><body>hi</body></html>", "<!--S-->"))
      .toBe("<html><!--S--><body>hi</body></html>");
  });

  it("prepends when there is neither head nor html", () => {
    expect(injectShim("<body>hi</body>", "<!--S-->")).toBe("<!--S--><body>hi</body>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/surface-shim.test.ts`
Expected: FAIL — cannot find module `../src/surfaces/shim.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard-host/src/surfaces/shim.ts

// Injected into served surface HTML. Attaches the surface's capability token as
// X-Rhumb-Surface-Token on same-origin /data/* fetch and XHR requests, so the
// data endpoint can identify the calling surface without trusting Referer.
export function renderShim(surfaceId: string, token: string): string {
  const T = JSON.stringify(token);
  const S = JSON.stringify(surfaceId);
  return (
    `<meta name="rhumb-surface-token" content=${JSON.stringify(token)}>` +
    `<script>(function(){` +
    `var T=${T},S=${S};` +
    `try{window.__RHUMB__={surfaceId:S,token:T};}catch(e){}` +
    `function d(u){try{var x=new URL(u,location.href);return x.origin===location.origin&&x.pathname.indexOf('/data/')===0;}catch(e){return false;}}` +
    `var f=window.fetch;` +
    `if(f){window.fetch=function(i,n){try{var u=(typeof i==='string')?i:(i&&i.url);if(d(u)){n=n||{};var h=new Headers(n.headers||(typeof i!=='string'&&i.headers)||{});h.set('X-Rhumb-Surface-Token',T);n.headers=h;}}catch(e){}return f.call(this,i,n);};}` +
    `var o=XMLHttpRequest.prototype.open,s=XMLHttpRequest.prototype.send;` +
    `XMLHttpRequest.prototype.open=function(m,u){this.__rd=d(u);return o.apply(this,arguments);};` +
    `XMLHttpRequest.prototype.send=function(b){if(this.__rd){try{this.setRequestHeader('X-Rhumb-Surface-Token',T);}catch(e){}}return s.apply(this,arguments);};` +
    `})();</script>`
  );
}

export function injectShim(html: string, markup: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag && htmlTag.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  return markup + html;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/surface-shim.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/surfaces/shim.ts dashboard-host/test/surface-shim.test.ts
git commit -m "feat(dashboard-host): surface token shim rendering + HTML injection"
```

---

### Task 3: Surface security headers

**Files:**
- Create: `dashboard-host/src/surfaces/headers.ts`
- Test: `dashboard-host/test/surface-headers.test.ts`

**Interfaces:**
- Produces: `surfaceHeaders(appOrigins: string[]): Record<string, string>` — the header map applied to every surface response.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard-host/test/surface-headers.test.ts
import { describe, it, expect } from "vitest";
import { surfaceHeaders } from "../src/surfaces/headers.js";

describe("surfaceHeaders", () => {
  it("sets nosniff and a CSP with connect-src 'self' and app-only frame-ancestors", () => {
    const h = surfaceHeaders(["tauri://localhost", "https://tauri.localhost"]);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors tauri://localhost https://tauri.localhost");
    expect(csp).not.toContain("frame-ancestors 'self'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/surface-headers.test.ts`
Expected: FAIL — cannot find module `../src/surfaces/headers.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard-host/src/surfaces/headers.ts

// Security headers set on every surface response. connect-src 'self' blocks a
// malicious surface from exfiltrating data or its token off-host; frame-ancestors
// is the Tauri app origins ONLY (not 'self') so one surface cannot frame another
// (both share the dashboard origin) while the app still can.
export function surfaceHeaders(appOrigins: string[]): Record<string, string> {
  const ancestors = appOrigins.length > 0 ? appOrigins.join(" ") : "'none'";
  const csp = [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/surface-headers.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/surfaces/headers.ts dashboard-host/test/surface-headers.test.ts
git commit -m "feat(dashboard-host): surface security headers"
```

---

### Task 4: `RHUMB_APP_ORIGINS` config

**Files:**
- Modify: `dashboard-host/src/config.ts`
- Test: `dashboard-host/test/config.test.ts`

**Interfaces:**
- Produces: `Config.appOrigins: string[]` on the object returned by `loadConfig`.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` in `config.test.ts`)

```typescript
  it("defaults appOrigins to the Tauri origins and parses RHUMB_APP_ORIGINS", () => {
    expect(loadConfig({}).appOrigins).toEqual(["tauri://localhost", "https://tauri.localhost"]);
    expect(loadConfig({ RHUMB_APP_ORIGINS: "tauri://localhost, http://x:1" }).appOrigins)
      .toEqual(["tauri://localhost", "http://x:1"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/config.test.ts`
Expected: FAIL — `appOrigins` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `dashboard-host/src/config.ts`, add `appOrigins: string[];` to the `Config` interface, and in the returned object of `loadConfig` add:

```typescript
    appOrigins: (env.RHUMB_APP_ORIGINS?.trim()
      ? env.RHUMB_APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : ["tauri://localhost", "https://tauri.localhost"]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/config.ts dashboard-host/test/config.test.ts
git commit -m "feat(dashboard-host): RHUMB_APP_ORIGINS config for surface CSP"
```

---

### Task 5: Serve surfaces with headers + injected shim

**Files:**
- Modify: `dashboard-host/src/server.ts` (the `createServer` deps and `serveSurface`)
- Test: `dashboard-host/test/server.test.ts`

**Interfaces:**
- Consumes: `getOrCreateSurfaceToken` (Task 1), `renderShim`/`injectShim` (Task 2), `surfaceHeaders` (Task 3).
- Produces: `createServer` now accepts `appOrigins: string[]` in its deps; surface HTML responses carry the shim + security headers; non-HTML assets carry headers only.

- [ ] **Step 1: Write the failing test** (append to `dashboard-host/test/server.test.ts`; reuse its existing surface-writing helpers/imports — a surface is a dir under `<workspace>/surfaces/<id>/` with `surface.json` `{id,title,kind:"file",entry:"index.html"}` and the entry file)

```typescript
  it("injects the token shim and security headers into served surface HTML", async () => {
    // Arrange: create a surface d1 with an index.html (follow the existing
    // helper in this file that writes surface.json + entry).
    writeSurface("d1", "index.html", "<html><head></head><body>hi</body></html>");
    const app = createServer({ getSnapshot: () => ({ surfaces: [] }), workspace: ws, subscribers: new Set(), appOrigins: ["tauri://localhost"] });
    const res = await request(app).get("/surfaces/d1/");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(res.text).toContain("X-Rhumb-Surface-Token");
    expect(res.text).toContain("hi"); // original body preserved
  });

  it("sets headers but does not inject the shim into non-HTML assets", async () => {
    writeSurface("d2", "index.html", "<html></html>");
    writeAsset("d2", "app.js", "console.log(1)");
    const app = createServer({ getSnapshot: () => ({ surfaces: [] }), workspace: ws, subscribers: new Set(), appOrigins: ["tauri://localhost"] });
    const res = await request(app).get("/surfaces/d2/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.text).not.toContain("X-Rhumb-Surface-Token");
  });
```

> If `writeSurface`/`writeAsset`/`ws`/`request` helpers do not already exist in `server.test.ts`, add them at the top of the file: `ws = mkdtempSync(...)`, `writeSurface(id, entry, html)` writes `surfaces/<id>/surface.json` + entry, `writeAsset(id, name, body)` writes `surfaces/<id>/<name>`, and `import request from "supertest"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/server.test.ts`
Expected: FAIL — `appOrigins` not accepted / no shim in output.

- [ ] **Step 3: Write minimal implementation**

In `dashboard-host/src/server.ts`:

Add imports:
```typescript
import { readFileSync } from "node:fs";
import { getOrCreateSurfaceToken } from "./surfaces/token.js";
import { renderShim, injectShim } from "./surfaces/shim.js";
import { surfaceHeaders } from "./surfaces/headers.js";
```

Add `appOrigins: string[];` to the `createServer` deps type. Compute `const headers = surfaceHeaders(deps.appOrigins);` once inside `createServer`. Then replace the final `res.sendFile(realTarget, …)` block in `serveSurface` with:

```typescript
    res.set(headers);
    if (/\.html?$/i.test(realTarget)) {
      let html: string;
      try { html = readFileSync(realTarget, "utf8"); } catch { res.sendStatus(404); return; }
      const token = getOrCreateSurfaceToken(surfaceDir);
      res.type("html").send(injectShim(html, renderShim(id, token)));
      return;
    }
    res.sendFile(realTarget, (err) => {
      if (err) res.sendStatus(404);
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/server.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Update the caller and build**

In `dashboard-host/src/index.ts`, pass `appOrigins: deps.config.appOrigins` into the `createServer({...})` call.

Run: `cd dashboard-host && npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard-host/src/server.ts dashboard-host/src/index.ts dashboard-host/test/server.test.ts
git commit -m "feat(dashboard-host): inject token shim + security headers when serving surfaces"
```

---

### Task 6: Data endpoint auth by token

**Files:**
- Modify: `dashboard-host/src/data/router.ts`
- Modify: `dashboard-host/src/index.ts` (wire `resolveToken`)
- Test: `dashboard-host/test/data-router.test.ts`

**Interfaces:**
- Consumes: `resolveSurfaceToken` (Task 1).
- Produces: `DataRouterDeps.resolveToken: (token: string) => string | null`. `/data/:source/query` requires a valid token (else `401`). `/data/:source/write` derives the surface id from the `X-Rhumb-Surface-Token` header (not `Referer`).

- [ ] **Step 1: Write the failing test** (add a new `describe` in `data-router.test.ts`; the existing `app()` helper must be updated to pass a `resolveToken` — see Step 3 note)

```typescript
  describe("token-based data auth", () => {
    // resolveToken maps the fixed test token to surface "d1"
    const TOKEN = "surface-d1-token";
    function tokenApp() {
      let n = 0;
      const now = () => "T";
      const getExecutor = () => executor;
      const queue = new PendingQueue({ getExecutor, auditPath: join(dir, "a.jsonl"), now, id: () => `p${++n}` });
      const router = createDataRouter({
        getSources: () => sources, getExecutor, queue, trustPath: join(dir, "trust.json"),
        auditPath: join(dir, "a.jsonl"), now,
        resolveToken: (t) => (t === TOKEN ? "d1" : null),
      });
      const a = express(); a.use(express.json()); a.use("/data", router);
      return a;
    }

    it("query without a valid surface token is 401", async () => {
      const res = await request(tokenApp()).post("/data/ops/query").send({ op: { kind: "select", table: "t" } });
      expect(res.status).toBe(401);
    });

    it("query with a valid surface token returns rows", async () => {
      const res = await request(tokenApp()).post("/data/ops/query")
        .set("X-Rhumb-Surface-Token", TOKEN).send({ op: { kind: "select", table: "t" } });
      expect(res.status).toBe(200);
    });

    it("a forged Referer without a token cannot get a direct write (it enqueues)", async () => {
      const res = await request(tokenApp()).post("/data/ops/write")
        .set("Referer", "http://h/surfaces/d1/x") // forged, no token
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      expect(res.status).toBe(202); // untrusted → enqueued, not executed
    });

    it("a trusted surface writes directly when it presents its token", async () => {
      const { addTrust } = await import("../src/data/trust.js");
      addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
      const res = await request(tokenApp()).post("/data/ops/write")
        .set("X-Rhumb-Surface-Token", TOKEN)
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("executed");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: FAIL — `resolveToken` not used; query returns 200 without a token; forged-Referer write executes.

- [ ] **Step 3: Write minimal implementation**

In `dashboard-host/src/data/router.ts`:
- Add `resolveToken: (token: string) => string | null;` to `DataRouterDeps`.
- Add a helper at the top of `createDataRouter`:

```typescript
  const surfaceIdFromToken = (req: Request): string | null =>
    deps.resolveToken(req.get("x-rhumb-surface-token") ?? "");
```

- In the `/:source/query` handler, immediately after resolving `source` (the 404 check), add:

```typescript
    if (surfaceIdFromToken(req) === null) return void res.status(401).json({ error: "unauthorized" });
```

- In the `/:source/write` handler, replace `const surfaceId = surfaceIdFromReferer(req);` with:

```typescript
    const surfaceId = surfaceIdFromToken(req);
```

Leave `surfaceIdFromReferer` exported and defined (still covered by `referer.test.ts`) but no longer used for authorization.

Then update the **existing** `app()` helper in `data-router.test.ts` to supply a permissive `resolveToken` so the pre-existing tests (which don't send tokens) keep exercising the write/pending paths: add `resolveToken: () => "d1",` to its `createDataRouter({...})` call, and for the query test in the existing suite add `.set("X-Rhumb-Surface-Token", "x")` — since the helper's `resolveToken` ignores its argument and returns `"d1"`, any header value resolves. (The new `tokenApp()` suite above is what exercises the null/valid distinction.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: PASS (existing + new `describe`).

- [ ] **Step 5: Wire `resolveToken` in `index.ts`**

In `dashboard-host/src/index.ts`, import `resolveSurfaceToken` from `./surfaces/token.js` and add to the `createDataRouter({...})` deps:

```typescript
      resolveToken: (t) => resolveSurfaceToken(surfacesRoot, t),
```

Run: `cd dashboard-host && npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard-host/src/data/router.ts dashboard-host/src/index.ts dashboard-host/test/data-router.test.ts
git commit -m "feat(dashboard-host): authorize /data by surface token instead of Referer"
```

---

### Task 7: Full dashboard suite + integration smoke

**Files:**
- Test: `dashboard-host/test/index.smoke.test.ts` (extend if a surface→data round trip is easy to assert; otherwise this task is the full-suite gate)

- [ ] **Step 1: Run the full dashboard suite**

Run: `cd dashboard-host && npm test`
Expected: PASS, all files. Confirm no test still assumes tokenless `/data/query` succeeds.

- [ ] **Step 2: Build**

Run: `cd dashboard-host && npm run build`
Expected: no errors.

- [ ] **Step 3: Commit any test fixups**

```bash
git add dashboard-host/test
git commit -m "test(dashboard-host): align data tests with token auth" || echo "nothing to commit"
```

---

### Task 8: Client — lock detached surface windows out of Tauri capabilities (C2)

> **Part C — verified in the Tauri dev environment, not vitest.**

**Files:**
- Modify (if needed): `client/src-tauri/capabilities/default.json`
- Inspect: `client/src/components/Canvas.tsx` (the `detach()` `WebviewWindow` call)

**Interfaces:**
- Produces: detached surface windows (label `surface:<id>`) inherit **no** Tauri command capabilities.

- [ ] **Step 1: Confirm capability scoping**

Read `client/src-tauri/capabilities/default.json`. Confirm every capability object is scoped `"windows": ["main"]` (no `"surface:*"`, no wildcard). If any capability lacks an explicit window scope, add `"windows": ["main"]` to it.

- [ ] **Step 2: Add an explicit assertion in the detach path**

In `client/src/components/Canvas.tsx`, keep `detach()` opening the `WebviewWindow` but add a code comment documenting that the `surface:*` label intentionally matches no capability, so the window has no IPC access. (No functional change if Step 1 already holds.)

- [ ] **Step 3: Verify in Tauri**

Run: `cd client && npm run tauri dev`
Manually: open a surface, click Detach, and in the detached window's devtools console confirm `window.__TAURI__` is undefined (or that `invoke` is unavailable). Load a surface and confirm it still renders and can call `/data` (its shim attaches the token).

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/capabilities/default.json client/src/components/Canvas.tsx
git commit -m "fix(client): ensure detached surface windows have no Tauri capabilities"
```

---

### Task 9: Client — document the iframe sandbox rationale (C1) and tighten app-shell img-src

> **Part C — verified in the Tauri dev environment, not vitest.**

**Files:**
- Modify: `client/test/Canvas.test.tsx` (replace the misleading sandbox comment/assertion)
- Modify: `client/src-tauri/tauri.conf.json` (app-shell `img-src`)

- [ ] **Step 1: Update the Canvas sandbox test/comment**

In `client/test/Canvas.test.tsx`, replace the comment that treats `allow-scripts` alone as the safety property with one that states the real rationale: the app shell is a different origin (`tauri://`) so a surface cannot script it; per-surface tokens isolate data access; and the surface CSP (`connect-src 'self'`) blocks exfiltration. Keep the existing assertion that the iframe has a `sandbox` attribute including `allow-scripts`.

- [ ] **Step 2: Tighten app-shell img-src**

In `client/src-tauri/tauri.conf.json`, change the app CSP `img-src` from `'self' data: http: https:` to `'self' data:`. Leave `frame-src` as-is (it must still permit the runtime-configured dashboard origin).

- [ ] **Step 3: Verify in Tauri**

Run: `cd client && npm run tauri dev`
Manually: confirm the app shell renders, surfaces load in the Canvas, and the console shows no CSP violations for the app's own UI.

- [ ] **Step 4: Run the client unit suite**

Run: `cd client && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/test/Canvas.test.tsx client/src-tauri/tauri.conf.json
git commit -m "docs(client): iframe sandbox rationale; tighten app-shell img-src"
```

---

### Task 10: Update SECURITY.md known-gaps

**Files:**
- Modify: `SECURITY.md`

- [ ] **Step 1: Revise the known-gaps section**

In `SECURITY.md`, under "Known hardening gaps", remove `Referer`-based write authorization from the open-gaps list (it is now token-based) and note the residual, accepted limit from the spec: *an attacker who can `GET` a specific surface can scrape that surface's token and act as that surface; the control-token still gates approve/infra actions.*

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
git commit -m "docs: SECURITY.md reflects token-based surface data auth"
```

---

## Self-Review

**Spec coverage:**
- §2.1 per-surface token generation/storage/injection → Tasks 1, 2, 5.
- §2.2 data auth by token (query 401, write via token, Referer advisory) → Task 6.
- §2.3 security headers (`connect-src 'self'`, `frame-ancestors` app-only) → Tasks 3, 5.
- §2.4 client C2 (no capabilities on detached windows) → Task 8; C1 (keep sandbox, rationale) + app-shell CSP → Task 9.
- §4 "accepts" documented → Task 10.
- §5 testing → Tasks 1–7 (dashboard, in-env) and Tasks 8–9 (Tauri, operator-verified).

**Placeholder scan:** none — every code step contains complete code; Part C manual steps are explicit commands/checks (they are genuinely environment-verified, not placeholders).

**Type consistency:** `getOrCreateSurfaceToken(surfaceDir)`, `resolveSurfaceToken(surfacesRoot, token)`, `renderShim(surfaceId, token)`, `injectShim(html, markup)`, `surfaceHeaders(appOrigins)`, `DataRouterDeps.resolveToken(token)`, `Config.appOrigins` — names used identically across Tasks 1–7. `createServer` gains `appOrigins`; wired in Task 5 Step 5.
