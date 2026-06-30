import { describe, it, expect } from "vitest";
import { reduceAgent, initialAgentState, type AgentState } from "../src/lib/agentEvents";
import type { AgentEvent } from "../src/lib/types";

function run(events: AgentEvent[]): AgentState {
  return events.reduce(reduceAgent, initialAgentState);
}

describe("reduceAgent", () => {
  it("records the session id from a session event", () => {
    const s = run([{ type: "session", sessionId: "abc" }]);
    expect(s.sessionId).toBe("abc");
    expect(s.messages).toEqual([]);
  });

  it("appends result and error messages", () => {
    const s = run([
      { type: "result", result: "done", isError: false },
      { type: "error", message: "boom" },
    ]);
    expect(s.messages).toEqual([
      { kind: "result", text: "done" },
      { kind: "error", text: "boom" },
    ]);
  });

  it("extracts text and tool_use blocks from a raw assistant message", () => {
    const raw: AgentEvent = {
      type: "raw",
      message: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", name: "Read", input: { file: "a.ts" } },
          ],
        },
      },
    };
    const s = run([raw]);
    expect(s.messages).toEqual([
      { kind: "text", text: "let me check" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { file: "a.ts" } },
    ]);
  });

  it("ignores raw events it does not understand", () => {
    const s = run([{ type: "raw", message: { type: "system", subtype: "other" } }]);
    expect(s.messages).toEqual([]);
  });

  it("does not mutate the previous state", () => {
    const before = initialAgentState;
    const after = reduceAgent(before, { type: "result", result: "x", isError: false });
    expect(before.messages).toEqual([]);
    expect(after).not.toBe(before);
  });

  it("renders an errored result as an error message", () => {
    const s = run([{ type: "result", result: "failed run", isError: true }]);
    expect(s.messages).toEqual([{ kind: "error", text: "failed run" }]);
  });

  it("still renders a successful result as a result message", () => {
    const s = run([{ type: "result", result: "done", isError: false }]);
    expect(s.messages).toEqual([{ kind: "result", text: "done" }]);
  });
});
