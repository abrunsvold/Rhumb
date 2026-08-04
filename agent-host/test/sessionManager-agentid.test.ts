import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/sessionManager.js";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";

/** Captures the `ref` SessionManager hands `backend.send`, so these tests
 *  can assert on `agentId` without any real backend logic. */
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

describe("SessionManager.resolveAgentId wiring (fix round 1, C1)", () => {
  it("without a resolver, agentId falls back to sessionId ?? '' — SDK path stays byte-identical", async () => {
    const captured: AgentRef[] = [];
    const mgr = new SessionManager({ backend: fakeBackend("sdk", captured), model: "m", workspace: "/ws" });

    await mgr.run("hi", undefined, () => {});
    await mgr.run("hi again", "sess-1", () => {});

    expect(captured[0].agentId).toBe("");
    expect(captured[0].nativeId).toBeNull();
    expect(captured[1].agentId).toBe("sess-1");
    expect(captured[1].nativeId).toBe("sess-1");
  });

  it("with a resolver, agentId comes from resolveAgentId(sessionId), never sessionId directly", async () => {
    const captured: AgentRef[] = [];
    const mgr = new SessionManager({
      backend: fakeBackend("mngr", captured),
      resolveAgentId: (sessionId) => (sessionId ? `resolved-${sessionId}` : "minted-fresh"),
      model: "m",
      workspace: "/ws",
    });

    await mgr.run("hi", undefined, () => {});
    await mgr.run("hi again", "native-1", () => {});

    expect(captured[0].agentId).toBe("minted-fresh");
    expect(captured[1].agentId).toBe("resolved-native-1");
    // The resolver only ever substitutes agentId — nativeId in the ref stays
    // exactly what the caller passed as sessionId.
    expect(captured[0].nativeId).toBeNull();
    expect(captured[1].nativeId).toBe("native-1");
  });

  it("the resolver is called with the raw incoming sessionId, unmodified", async () => {
    const captured: AgentRef[] = [];
    const seen: (string | undefined)[] = [];
    const mgr = new SessionManager({
      backend: fakeBackend("mngr", captured),
      resolveAgentId: (sessionId) => {
        seen.push(sessionId);
        return sessionId ?? "minted";
      },
      model: "m",
      workspace: "/ws",
    });

    await mgr.run("a", undefined, () => {});
    await mgr.run("b", "some-id", () => {});

    expect(seen).toEqual([undefined, "some-id"]);
  });
});
