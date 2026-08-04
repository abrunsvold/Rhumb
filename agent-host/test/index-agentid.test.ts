import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrAgentIdResolver } from "../src/index.js";
import { createAgentRegistry } from "../src/agents.js";

let dir: string;
// Monotonically increasing timestamp so registry records get distinct
// `createdAt` values — needed to test "reuse the NEWEST unbound principal"
// (A2) meaningfully; a constant `now()` would make every record look
// equally new and the sort a no-op.
let tick = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-agentid-"));
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeRegistry() {
  let n = 0;
  return createAgentRegistry({
    indexPath: join(dir, "agents.json"),
    now: () => new Date(2026, 7, 3, 0, 0, tick++).toISOString(),
    // Deliberately NOT "rhumb-..." — this is the test fixture's own id
    // generator, not production's (that's index.ts's real `id: () =>
    // \`rhumb-${randomUUID()}\``, wired in buildApp, not exercised here).
    // Fix round 3, Minor 4: earlier assertions matched this fixture's
    // incidental "rhumb-" prefix as if it were a guarantee the resolver
    // makes, which it doesn't — the resolver never touches agentId format,
    // only the registry's `id()` dep does.
    id: () => `fixture-agent-${++n}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

describe("createMngrAgentIdResolver — minting and adoption (fix round 1, C1)", () => {
  it("mints exactly one principal for a brand-new session and persists it to agents.json", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const resolved = resolve(undefined);

    expect(resolved.nativeId).toBeNull();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].agentId).toBe(resolved.agentId);
    expect(registry.list()[0].backend).toBe("mngr");
    expect(existsSync(join(dir, "agents.json"))).toBe(true);
  });

  it("the minted display name satisfies mngr.ts's VALID_MNGR_NAME (the resolver's own default, not the registry's id())", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    resolve(undefined);
    expect(registry.list()[0].name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("a later turn whose sessionId is the previously-bound mngr nativeId resolves back to the SAME principal AND that nativeId, minting nothing new", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const first = resolve(undefined);
    // Simulates what mngr.ts's ensureAgent does once `create` succeeds and
    // resolveNativeIdByLabel confirms the mngr agent id: registry.bind.
    registry.bind(first.agentId, "agent-native-1");

    const second = resolve("agent-native-1");

    expect(second.agentId).toBe(first.agentId);
    expect(second.nativeId).toBe("agent-native-1");
    expect(registry.list()).toHaveLength(1);
  });

  it("repeated turns on the same bound nativeId never mint a second principal", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const first = resolve(undefined);
    registry.bind(first.agentId, "agent-native-1");

    resolve("agent-native-1");
    resolve("agent-native-1");
    resolve("agent-native-1");

    expect(registry.list()).toHaveLength(1);
  });
});

describe("createMngrAgentIdResolver — nativeId is derived, never echoed from the wire (fix round 3, A1)", () => {
  it("an unrecognised/foreign incoming id never becomes nativeId — it resolves with nativeId: null instead", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const resolved = resolve("attacker-supplied-or-otherwise-foreign-id");
    // The whole point of A1: this id was never bound to anything Rhumb
    // created, so it must never come back out as a nativeId — that would
    // let a caller run `mngr message <that id>` against an agent this
    // backend never scrubbed credentials for.
    expect(resolved.nativeId).toBeNull();
    expect(resolved.agentId).not.toBe("attacker-supplied-or-otherwise-foreign-id");
  });

  it("an incoming id that is itself a known agentId resolves via the registry record, not by echoing the id as nativeId (Minor 2)", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const minted = resolve(undefined);

    // minted.agentId was never bound, so its record's nativeId is still
    // null — resolving on the agentId itself must reflect THAT, not the
    // agentId string being reinterpreted as a nativeId.
    const resolved = resolve(minted.agentId);
    expect(resolved.agentId).toBe(minted.agentId);
    expect(resolved.nativeId).toBeNull();

    registry.bind(minted.agentId, "agent-native-9");
    const resolvedAfterBind = resolve(minted.agentId);
    expect(resolvedAfterBind.agentId).toBe(minted.agentId);
    expect(resolvedAfterBind.nativeId).toBe("agent-native-9");
  });

  it("a bound-then-stopped principal resolves with nativeId: null, keeping mngr.ts's stopped refusal reachable", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const minted = resolve(undefined);
    registry.bind(minted.agentId, "agent-native-1");
    registry.markStopped(minted.agentId);

    const resolved = resolve("agent-native-1");

    // The record's `nativeId` field is untouched by markStopped (still
    // "agent-native-1"), but a stopped principal must never hand that back
    // as a trusted nativeId — mngr.ts's send() only calls ensureAgent (the
    // one place that actually refuses a stopped principal) when nativeId is
    // falsy, so echoing the stale value would silently bypass that refusal.
    expect(resolved.agentId).toBe(minted.agentId);
    expect(resolved.nativeId).toBeNull();
  });
});

describe("createMngrAgentIdResolver — reuse-before-mint (fix round 3, A2)", () => {
  it("a turn that fails before any session event (still unbound), followed by a retry, reuses the SAME principal rather than minting a second", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    // First turn: no sessionId, resolver mints a principal. Simulates the
    // turn then failing before mngr.ts ever emits a `session` event (e.g.
    // create-failed / create-unconfirmed / invalid-name) — the principal
    // stays unbound (nativeId: null) in the registry.
    const first = resolve(undefined);
    expect(first.nativeId).toBeNull();

    // Retry: the client still has no sessionId to send back (the failed
    // turn never produced one), so this looks identical to a brand-new
    // session from the wire's perspective.
    const retry = resolve(undefined);

    expect(retry.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("three retries in a row all converge on the same unbound principal", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const first = resolve(undefined);

    const r2 = resolve(undefined);
    const r3 = resolve(undefined);
    const r4 = resolve("some-other-unrecognised-id");

    expect(r2.agentId).toBe(first.agentId);
    expect(r3.agentId).toBe(first.agentId);
    expect(r4.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("once the reused principal is bound, the NEXT unrecognised turn mints a fresh one instead of reusing the now-bound principal", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);
    const first = resolve(undefined);
    registry.bind(first.agentId, "agent-native-1");

    // No unbound principal remains, so this must mint rather than reuse
    // (and must not reuse the now-bound `first`, which belongs to a real
    // conversation).
    const second = resolve(undefined);

    expect(second.agentId).not.toBe(first.agentId);
    expect(registry.list()).toHaveLength(2);
  });

  it("a normal successful first turn still behaves as before: mint once, bind once, no reuse artifacts", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const first = resolve(undefined);
    registry.bind(first.agentId, "agent-native-1");
    const second = resolve("agent-native-1");

    expect(second.agentId).toBe(first.agentId);
    expect(second.nativeId).toBe("agent-native-1");
    expect(registry.list()).toHaveLength(1);
  });

  it("reuses the NEWEST unbound principal when more than one exists", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry);

    const older = resolve(undefined);
    // A second, independent unbound principal minted later (e.g. from a
    // concurrent first turn — Minor 1, deferred — or a second failed
    // conversation). Reuse must prefer the newer one, not whichever sorts
    // first in the registry file.
    const newer = registry.create("fixture-manually-minted-newer", "mngr");

    const reused = resolve("yet-another-unrecognised-id");

    expect(reused.agentId).toBe(newer.agentId);
    expect(reused.agentId).not.toBe(older.agentId);
    expect(registry.list()).toHaveLength(2);
  });
});
