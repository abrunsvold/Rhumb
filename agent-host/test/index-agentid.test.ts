import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrAgentIdResolver } from "../src/index.js";
import { createAgentRegistry, type AgentRegistry } from "../src/agents.js";

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

function makeRegistry(): AgentRegistry {
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

/** Every test below constructs its OWN `inFlight` Set explicitly and passes
 *  it to `createMngrAgentIdResolver`, mirroring how `buildApp` shares one
 *  Set between the resolver and `releaseAgentId` (fix round 4, B2) — rather
 *  than relying on the resolver's private default Set, which no test could
 *  ever release from (it's not exposed). Releasing a principal from
 *  `inFlight` is what `SessionManager`'s `finally` does once a turn
 *  completes in production (see `sessionManager.ts`); tests that want to
 *  simulate "the previous turn finished" must do the same explicitly. */
function release(inFlight: Set<string>, resolved: { agentId: string }): void {
  inFlight.delete(resolved.agentId);
}

describe("createMngrAgentIdResolver — minting and adoption (fix round 1, C1)", () => {
  it("mints exactly one principal for a brand-new session and persists it to agents.json", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry, { inFlight: new Set() });

    const resolved = resolve(undefined);

    expect(resolved.nativeId).toBeNull();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].agentId).toBe(resolved.agentId);
    expect(registry.list()[0].backend).toBe("mngr");
    expect(existsSync(join(dir, "agents.json"))).toBe(true);
  });

  it("the minted display name satisfies mngr.ts's VALID_MNGR_NAME (the resolver's own default, not the registry's id())", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry, { inFlight: new Set() });
    resolve(undefined);
    expect(registry.list()[0].name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("a later turn whose sessionId is the previously-bound mngr nativeId resolves back to the SAME principal, minting nothing new", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const first = resolve(undefined);
    release(inFlight, first);
    // Simulates what mngr.ts's ensureAgent does once `create` succeeds and
    // resolveNativeIdByLabel confirms the mngr agent id: registry.bind.
    registry.bind(first.agentId, "agent-native-1");

    const second = resolve("agent-native-1");

    expect(second.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("repeated turns on the same bound nativeId never mint a second principal", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const first = resolve(undefined);
    release(inFlight, first);
    registry.bind(first.agentId, "agent-native-1");

    resolve("agent-native-1");
    resolve("agent-native-1");
    resolve("agent-native-1");

    expect(registry.list()).toHaveLength(1);
  });
});

describe("createMngrAgentIdResolver — nativeId is ALWAYS null (fix round 4, B1)", () => {
  // B1: the resolver used to derive nativeId from the registry (round 3,
  // A1), which fixed the ownership bypass but still pre-empted
  // ensureAgent — the ONLY place that actually checks liveness, respawns a
  // dead agent, or refuses a stopped principal — on every turn after the
  // first. The resolver now never hands back anything but nativeId: null,
  // so every turn routes through ensureAgent. Proving ensureAgent itself
  // then does the right thing with that (dead-agent respawn in particular)
  // is a mngr.ts-level concern, not this resolver's — see
  // "send() with nativeId: null re-creates a dead bound agent" in
  // test/backend-mngr.test.ts for that half of B1.

  it("a fresh mint resolves with nativeId: null", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry, { inFlight: new Set() });
    expect(resolve(undefined).nativeId).toBeNull();
  });

  it("a bound principal's sessionId still resolves with nativeId: null, not the bound value", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const first = resolve(undefined);
    release(inFlight, first);
    registry.bind(first.agentId, "agent-native-1");

    const second = resolve("agent-native-1");

    expect(second.agentId).toBe(first.agentId);
    expect(second.nativeId).toBeNull();
  });

  it("an unrecognised/foreign incoming id never becomes nativeId (A1's ownership fix, still true under B1)", () => {
    const registry = makeRegistry();
    const resolve = createMngrAgentIdResolver(registry, { inFlight: new Set() });
    const resolved = resolve("attacker-supplied-or-otherwise-foreign-id");
    expect(resolved.nativeId).toBeNull();
    expect(resolved.agentId).not.toBe("attacker-supplied-or-otherwise-foreign-id");
  });

  it("an incoming id that is itself a known agentId resolves via the record's agentId, nativeId still null (Minor 2)", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const minted = resolve(undefined);
    release(inFlight, minted);

    const resolved = resolve(minted.agentId);
    expect(resolved.agentId).toBe(minted.agentId);
    expect(resolved.nativeId).toBeNull();

    registry.bind(minted.agentId, "agent-native-9");
    const resolvedAfterBind = resolve(minted.agentId);
    expect(resolvedAfterBind.agentId).toBe(minted.agentId);
    expect(resolvedAfterBind.nativeId).toBeNull();
  });

  it("a bound-then-stopped principal still resolves (agentId), with nativeId null as always", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const minted = resolve(undefined);
    release(inFlight, minted);
    registry.bind(minted.agentId, "agent-native-1");
    registry.markStopped(minted.agentId);

    const resolved = resolve("agent-native-1");

    // The resolver itself no longer special-cases "stopped" at all — it
    // doesn't need to, since nativeId is unconditionally null and
    // ensureAgent (mngr.ts) is what actually refuses a stopped principal,
    // every single turn, now that it's always reached.
    expect(resolved.agentId).toBe(minted.agentId);
    expect(resolved.nativeId).toBeNull();
  });
});

describe("createMngrAgentIdResolver — reuse-before-mint (fix round 3, A2)", () => {
  it("a turn that fails before any session event, released, then retried, reuses the SAME principal rather than minting a second", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    // First turn: no sessionId, resolver mints a principal. Simulates the
    // turn then failing before mngr.ts ever emits a `session` event (e.g.
    // create-failed / create-unconfirmed / invalid-name) — the principal
    // stays unbound (nativeId: null) in the registry. The turn still
    // COMPLETES (the failure is reported to the client, not a hang), so
    // SessionManager's `finally` releases it — simulated here explicitly.
    const first = resolve(undefined);
    expect(first.nativeId).toBeNull();
    release(inFlight, first);

    // Retry: the client still has no sessionId to send back (the failed
    // turn never produced one), so this looks identical to a brand-new
    // session from the wire's perspective.
    const retry = resolve(undefined);

    expect(retry.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("three released retries in a row all converge on the same unbound principal", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const first = resolve(undefined);
    release(inFlight, first);

    const r2 = resolve(undefined);
    release(inFlight, r2);
    const r3 = resolve(undefined);
    release(inFlight, r3);
    const r4 = resolve("some-other-unrecognised-id");

    expect(r2.agentId).toBe(first.agentId);
    expect(r3.agentId).toBe(first.agentId);
    expect(r4.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("once the reused principal is bound, the NEXT unrecognised turn mints a fresh one instead of reusing the now-bound principal", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });
    const first = resolve(undefined);
    release(inFlight, first);
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
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const first = resolve(undefined);
    release(inFlight, first);
    registry.bind(first.agentId, "agent-native-1");
    const second = resolve("agent-native-1");

    expect(second.agentId).toBe(first.agentId);
    expect(registry.list()).toHaveLength(1);
  });

  it("reuses the NEWEST unbound, released, not-in-flight principal when more than one is eligible", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const older = resolve(undefined);
    release(inFlight, older);
    // A second, independent unbound principal minted later (e.g. a second
    // released-and-retried conversation). Reuse must prefer the newer one,
    // not whichever sorts first in the registry file.
    const newer = registry.create("fixture-manually-minted-newer", "mngr");

    const reused = resolve("yet-another-unrecognised-id");

    expect(reused.agentId).toBe(newer.agentId);
    expect(reused.agentId).not.toBe(older.agentId);
    expect(registry.list()).toHaveLength(2);
  });

  it("the newest-first sort does not misbehave on a createdAt tie (Minor: comparator must return 0, not just -1/1)", () => {
    // A dedicated registry whose `now()` is CONSTANT, so both unbound
    // records genuinely tie on createdAt — makeRegistry()'s incrementing
    // clock can't produce a tie by construction.
    let n = 0;
    const tiedRegistry = createAgentRegistry({
      indexPath: join(dir, "tied-agents.json"),
      now: () => "2026-08-03T00:00:00.000Z",
      id: () => `fixture-tied-${++n}`,
    });
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(tiedRegistry, { inFlight });

    const a = tiedRegistry.create("fixture-tie-a", "mngr");
    const b = tiedRegistry.create("fixture-tie-b", "mngr");
    expect(a.createdAt).toBe(b.createdAt);

    // Must resolve to ONE of the two tied candidates — a comparator that
    // never returns 0 on equal keys is non-conforming and, on some engines,
    // risks unstable or incorrect sort results rather than a clean pick.
    const resolved = resolve("id-that-matches-nothing");
    expect([a.agentId, b.agentId]).toContain(resolved.agentId);
    expect(tiedRegistry.list()).toHaveLength(2); // no third principal minted
  });
});

describe("createMngrAgentIdResolver — reuse filter clauses (fix round 4, Minor)", () => {
  it("does not reuse a STOPPED-but-unbound principal (status !== 'active' clause)", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const stopped = registry.create("fixture-stopped-unbound", "mngr");
    registry.markStopped(stopped.agentId); // still nativeId: null, now status: "stopped"

    const resolved = resolve(undefined);

    expect(resolved.agentId).not.toBe(stopped.agentId);
    expect(registry.list()).toHaveLength(2); // stopped one left alone, a fresh one minted
  });

  it("does not reuse an unbound record from a non-mngr backend (backend === 'mngr' clause)", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const sdkRecord = registry.create("fixture-sdk-record", "sdk");

    const resolved = resolve(undefined);

    expect(resolved.agentId).not.toBe(sdkRecord.agentId);
    expect(registry.list()).toHaveLength(2);
  });
});

describe("createMngrAgentIdResolver — in-flight tracking prevents concurrent collision (fix round 4, B2)", () => {
  it("two concurrent unresolved turns (neither released yet) mint TWO distinct principals — the regression guard for B2", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    // Simulates two draft-tab sends racing: both arrive as sessionId
    // undefined, and neither turn has completed (released) yet — e.g. tab
    // A's `mngr create` is still running when tab B sends. WITHOUT the
    // in-flight set, B would reuse A's still-unbound principal (A2's
    // reuse-before-mint), colliding two conversations onto one agent.
    const a = resolve(undefined);
    const b = resolve(undefined);

    expect(a.agentId).not.toBe(b.agentId);
    expect(registry.list()).toHaveLength(2);
    expect(registry.list().every((r) => r.nativeId === null)).toBe(true);
  });

  it("a third concurrent turn also mints its own, distinct from both in-flight principals", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const a = resolve(undefined);
    const b = resolve(undefined);
    const c = resolve(undefined);

    const ids = new Set([a.agentId, b.agentId, c.agentId]);
    expect(ids.size).toBe(3);
    expect(registry.list()).toHaveLength(3);
  });

  it("after A releases, a later turn CAN reuse A's still-unbound principal (release actually re-enables reuse)", () => {
    const registry = makeRegistry();
    const inFlight = new Set<string>();
    const resolve = createMngrAgentIdResolver(registry, { inFlight });

    const a = resolve(undefined);
    const b = resolve(undefined); // concurrent with A, mints its own
    expect(b.agentId).not.toBe(a.agentId);

    release(inFlight, a); // A's turn completes (e.g. it failed)
    const retryOfA = resolve(undefined);

    expect(retryOfA.agentId).toBe(a.agentId);
    expect(registry.list()).toHaveLength(2); // still just A and B, no third
  });
});
