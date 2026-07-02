import { describe, it, expect } from "vitest";
import { SessionManager, type QueryFn } from "../src/sessionManager.js";
import type { AgentEvent } from "../src/types.js";

// Fake SDK message stream: an init message, an opaque assistant message, a result.
function fakeQuery(messages: any[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

describe("SessionManager.run", () => {
  it("emits session, raw, then result events and resolves with the session id", async () => {
    const query = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", result: "done", is_error: false },
    ]);
    const mgr = new SessionManager({ query, model: "m", workspace: "./ws" });

    const events: AgentEvent[] = [];
    const id = await mgr.run("hello", undefined, (e) => events.push(e));

    expect(id).toBe("sess-1");
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-1" });
    expect(events[1]).toEqual({
      type: "raw",
      message: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    });
    expect(events[2]).toEqual({ type: "result", result: "done", isError: false });
  });

  it("passes resume + model + cwd into the query options", async () => {
    const calls: any[] = [];
    const query: QueryFn = (args) => {
      calls.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-2" };
        yield { type: "result", result: "", is_error: false };
      })();
    };
    const mgr = new SessionManager({ query, model: "claude-opus-4-8", workspace: "/ws" });
    await mgr.run("again", "sess-2", () => {});

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("again");
    expect(calls[0].options.resume).toBe("sess-2");
    expect(calls[0].options.model).toBe("claude-opus-4-8");
    expect(calls[0].options.cwd).toBe("/ws");
  });

  it("emits an error event when the generator throws", async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-3" };
        throw new Error("boom");
      })();
    const mgr = new SessionManager({ query, model: "m", workspace: "./ws" });

    const events: AgentEvent[] = [];
    await mgr.run("x", undefined, (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  });

  it("uses permissionMode from constructor opts when provided", async () => {
    const calls: any[] = [];
    const query: QueryFn = (args) => {
      calls.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-4" };
        yield { type: "result", result: "", is_error: false };
      })();
    };
    const mgr = new SessionManager({
      query,
      model: "m",
      workspace: "./ws",
      permissionMode: "plan",
    });
    await mgr.run("test", undefined, () => {});

    expect(calls).toHaveLength(1);
    expect(calls[0].options.permissionMode).toBe("plan");
  });

  it("includes slashCommands on the session event when the init message reports them", async () => {
    const events: AgentEvent[] = [];
    const manager = new SessionManager({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "s1", slash_commands: ["/compact", "/review"] };
        yield { type: "result", result: "done", is_error: false };
      },
      model: "m",
      workspace: "/tmp/w",
    });
    await manager.run("hi", undefined, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "session", sessionId: "s1", slashCommands: ["/compact", "/review"] });
  });

  it("omits slashCommands when the init message has none", async () => {
    const events: AgentEvent[] = [];
    const manager = new SessionManager({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "s2" };
      },
      model: "m",
      workspace: "/tmp/w",
    });
    await manager.run("hi", undefined, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "session", sessionId: "s2" });
  });
});
