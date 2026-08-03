import { describe, it, expect } from "vitest";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";
import type { AgentEvent } from "../src/types.js";

export const CONFORMANCE_SPEC = {
  model: "m",
  workspace: "/ws",
  permissionMode: "acceptEdits",
  extraOptions: {},
};

/** The contract every AgentBackend must satisfy. Both backends run this
 *  identical suite, so the interface cannot quietly become SDK-shaped. */
export function runBackendConformance(
  name: string,
  makeBackend: () => AgentBackend | Promise<AgentBackend>,
): void {
  describe(`AgentBackend conformance: ${name}`, () => {
    it("exposes a stable id", async () => {
      const backend = await makeBackend();
      expect(["sdk", "mngr"]).toContain(backend.id);
    });

    it("ensure returns a ref carrying the requested agentId and its own backend id", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-1", CONFORMANCE_SPEC);
      expect(ref.agentId).toBe("agent-conf-1");
      expect(ref.backend).toBe(backend.id);
    });

    it("ensure is idempotent: same agentId yields the same nativeId", async () => {
      const backend = await makeBackend();
      const first = await backend.ensure("agent-conf-2", CONFORMANCE_SPEC);
      const second = await backend.ensure("agent-conf-2", CONFORMANCE_SPEC);
      expect(second.agentId).toBe(first.agentId);
      expect(second.nativeId).toBe(first.nativeId);
    });

    it("send preserves agentId and emits a terminal result or error", async () => {
      const backend = await makeBackend();
      const ref: AgentRef = await backend.ensure("agent-conf-3", CONFORMANCE_SPEC);
      const events: AgentEvent[] = [];
      const out = await backend.send(ref, "hello", (e) => events.push(e));

      expect(out.agentId).toBe("agent-conf-3");
      expect(out.backend).toBe(backend.id);
      const last = events.at(-1);
      expect(last?.type === "result" || last?.type === "error").toBe(true);
    });

    it("send never throws: failures arrive as an error event", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-4", CONFORMANCE_SPEC);
      await expect(backend.send(ref, "hello", () => {})).resolves.toBeDefined();
    });

    it("list resolves to an array", async () => {
      const backend = await makeBackend();
      expect(Array.isArray(await backend.list())).toBe(true);
    });

    it("stop resolves for a known ref", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-5", CONFORMANCE_SPEC);
      await expect(backend.stop(ref)).resolves.toBeUndefined();
    });

    it("transcript resolves to an array or null, never throws", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-6", CONFORMANCE_SPEC);
      const t = await backend.transcript(ref);
      expect(t === null || Array.isArray(t)).toBe(true);
    });
  });
}
