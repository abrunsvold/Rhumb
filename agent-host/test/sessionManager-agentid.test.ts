import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/sessionManager.js";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";

/** Captures the `ref` SessionManager hands `backend.send`, so these tests
 *  can assert on `agentId`/`nativeId` without any real backend logic. */
function fakeBackend(id: "sdk" | "mngr", captured: AgentRef[]): AgentBackend {
  return {
    id,
    async ensure(agentId) {
      return { agentId, nativeId: null, backend: id };
    },
    async send(ref, _prompt, onEvent) {
      captured.push(ref);
      onEvent({ type: "session", sessionId: "native-1" });
      return { ...ref, nativeId: "native-1" };
    },
    async list() {
      return [];
    },
    async stop() {},
    async transcript() {
      return null;
    },
  };
}

describe("SessionManager.resolveAgentId wiring (fix round 1, C1; shape widened fix round 3, A1)", () => {
  it("without a resolver, agentId/nativeId fall back to sessionId ?? '' / sessionId ?? null — SDK path stays byte-identical", async () => {
    const captured: AgentRef[] = [];
    const mgr = new SessionManager({ backend: fakeBackend("sdk", captured), model: "m", workspace: "/ws" });

    await mgr.run("hi", undefined, () => {});
    await mgr.run("hi again", "sess-1", () => {});

    expect(captured[0].agentId).toBe("");
    expect(captured[0].nativeId).toBeNull();
    expect(captured[1].agentId).toBe("sess-1");
    expect(captured[1].nativeId).toBe("sess-1");
  });

  it("with a resolver, BOTH agentId and nativeId come from the resolver, never from sessionId directly (A1)", async () => {
    const captured: AgentRef[] = [];
    const mgr = new SessionManager({
      backend: fakeBackend("mngr", captured),
      resolveAgentId: (sessionId) =>
        sessionId
          ? { agentId: `resolved-${sessionId}`, nativeId: `verified-${sessionId}` }
          : { agentId: "minted-fresh", nativeId: null },
      model: "m",
      workspace: "/ws",
    });

    await mgr.run("hi", undefined, () => {});
    await mgr.run("hi again", "native-1", () => {});

    expect(captured[0].agentId).toBe("minted-fresh");
    expect(captured[0].nativeId).toBeNull();
    // Critically: nativeId is the resolver's OWN derived value, not the raw
    // wire sessionId ("native-1") — see the A1 doc comment on
    // SessionManager's resolveAgentId option for why echoing the wire value
    // verbatim was the bug.
    expect(captured[1].agentId).toBe("resolved-native-1");
    expect(captured[1].nativeId).toBe("verified-native-1");
  });

  it("an unrecognised sessionId resolved to nativeId: null never reaches the backend as a nativeId (A1 ownership check)", async () => {
    const captured: AgentRef[] = [];
    const mgr = new SessionManager({
      backend: fakeBackend("mngr", captured),
      // Simulates the real resolver's behaviour for a foreign/arbitrary
      // sessionId it does not recognise: agentId is still resolved (mint or
      // reuse), but nativeId is deliberately null so the backend's own
      // ensureAgent — not an unverified wire value — decides the real
      // nativeId.
      resolveAgentId: () => ({ agentId: "some-principal", nativeId: null }),
      model: "m",
      workspace: "/ws",
    });

    await mgr.run("hi", "attacker-supplied-foreign-native-id", () => {});

    expect(captured[0].agentId).toBe("some-principal");
    expect(captured[0].nativeId).toBeNull();
  });

  it("the resolver is called with the raw incoming sessionId, unmodified", async () => {
    const captured: AgentRef[] = [];
    const seen: (string | undefined)[] = [];
    const mgr = new SessionManager({
      backend: fakeBackend("mngr", captured),
      resolveAgentId: (sessionId) => {
        seen.push(sessionId);
        return { agentId: sessionId ?? "minted", nativeId: sessionId ?? null };
      },
      model: "m",
      workspace: "/ws",
    });

    await mgr.run("a", undefined, () => {});
    await mgr.run("b", "some-id", () => {});

    expect(seen).toEqual([undefined, "some-id"]);
  });
});
