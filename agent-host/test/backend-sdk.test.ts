import { describe, it, expect } from "vitest";
import { createSdkBackend } from "../src/backends/sdk.js";
import type { QueryFn } from "../src/sessionManager.js";
import type { AgentEvent } from "../src/types.js";

const spec = { model: "m", workspace: "/ws", permissionMode: "acceptEdits", extraOptions: {} };

function fakeQuery(messages: unknown[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

describe("sdk backend", () => {
  it("reports its id", () => {
    expect(createSdkBackend({ query: fakeQuery([]), spec }).id).toBe("sdk");
  });

  it("ensure is lazy: nativeId stays null until the first turn", async () => {
    const backend = createSdkBackend({ query: fakeQuery([]), spec });
    const ref = await backend.ensure("agent-1", spec);
    expect(ref).toEqual({ agentId: "agent-1", nativeId: null, backend: "sdk" });
  });

  it("send emits session/raw/result and returns the ref with nativeId set", async () => {
    const backend = createSdkBackend({
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        { type: "result", result: "done", is_error: false },
      ]),
      spec,
    });
    const events: AgentEvent[] = [];
    const out = await backend.send(
      { agentId: "agent-1", nativeId: null, backend: "sdk" },
      "hello",
      (e) => events.push(e),
    );

    expect(out.nativeId).toBe("sess-1");
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-1" });
    expect(events[2]).toEqual({ type: "result", result: "done", isError: false });
  });

  it("send passes resume when the ref already has a nativeId", async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const query: QueryFn = (args) => {
      calls.push(args as { prompt: string; options: Record<string, unknown> });
      return (async function* () {
        yield { type: "result", result: "", is_error: false };
      })();
    };
    const backend = createSdkBackend({ query, spec });
    await backend.send({ agentId: "a", nativeId: "sess-2", backend: "sdk" }, "again", () => {});

    expect(calls[0].options.resume).toBe("sess-2");
    expect(calls[0].options.model).toBe("m");
    expect(calls[0].options.cwd).toBe("/ws");
  });

  it("send emits an error event when the stream throws", async () => {
    const backend = createSdkBackend({
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          throw new Error("boom");
        })(),
      spec,
    });
    const events: AgentEvent[] = [];
    await backend.send({ agentId: "a", nativeId: null, backend: "sdk" }, "x", (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  });

  it("stop is a no-op and list returns empty (the SDK has no lifecycle)", async () => {
    const backend = createSdkBackend({ query: fakeQuery([]), spec });
    await expect(backend.stop({ agentId: "a", nativeId: null, backend: "sdk" })).resolves.toBeUndefined();
    await expect(backend.list()).resolves.toEqual([]);
  });
});
