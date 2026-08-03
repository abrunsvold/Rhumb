import { describe, it, expect } from "vitest";
import type { AgentBackend, AgentRef, BackendId } from "../src/backends/types.js";
import type { AgentEvent, TranscriptMessage } from "../src/types.js";

export const CONFORMANCE_SPEC = {
  model: "m",
  workspace: "/ws",
  permissionMode: "acceptEdits",
  extraOptions: {},
};

/** The contract every AgentBackend must satisfy. Both backends run this
 *  identical suite, so the interface cannot quietly become SDK-shaped. */
export function runBackendConformance(
  expectedId: BackendId,
  makeBackend: () => AgentBackend | Promise<AgentBackend>,
  makeFailingBackend?: () => AgentBackend | Promise<AgentBackend>,
): void {
  describe(`AgentBackend conformance: ${expectedId}`, () => {
    it("exposes a stable id matching the expected backend", async () => {
      const backend = await makeBackend();
      expect(backend.id).toBe(expectedId);
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
      // Ensure does not create duplicates in list()
      const listed = await backend.list();
      expect(listed.filter(r => r.agentId === "agent-conf-2").length).toBeLessThanOrEqual(1);
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

    it("send does not throw on success", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-4", CONFORMANCE_SPEC);
      await expect(backend.send(ref, "hello", () => {})).resolves.toBeDefined();
    });

    it.skipIf(!makeFailingBackend)(
      "send never throws: failures arrive as an error event",
      async () => {
        const backend = await makeFailingBackend!();
        const ref = await backend.ensure("agent-conf-4-fail", CONFORMANCE_SPEC);
        const events: AgentEvent[] = [];
        const result = await backend.send(ref, "hello", (e) => events.push(e));
        // send() must resolve (not throw)
        expect(result).toBeDefined();
        // Failure must arrive as an error event
        const lastEvent = events.at(-1);
        expect(lastEvent?.type).toBe("error");
      },
    );

    it("list resolves to an array", async () => {
      const backend = await makeBackend();
      expect(Array.isArray(await backend.list())).toBe(true);
    });

    it("stop resolves for a known ref and removes it from list()", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-5", CONFORMANCE_SPEC);
      await expect(backend.stop(ref)).resolves.toBeUndefined();
      // After stop, the agentId must not appear in list()
      const listed = await backend.list();
      expect(listed.every(r => r.agentId !== ref.agentId)).toBe(true);
    });

    it("transcript resolves to an array or null, never throws", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-6", CONFORMANCE_SPEC);
      const t = await backend.transcript(ref);
      if (t !== null) {
        // If non-null, must be an array of TranscriptMessages
        expect(Array.isArray(t)).toBe(true);
        for (const msg of t) {
          // Each message must have required TranscriptMessage shape
          expect(typeof msg.kind).toBe("string");
          expect(["text", "result", "error", "tool", "user"]).toContain(msg.kind);
          expect(typeof msg.text).toBe("string");
        }
      }
    });
  });
}
