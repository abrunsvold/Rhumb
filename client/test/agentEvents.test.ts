import { describe, it, expect } from "vitest";
import { reduceAgent, initialAgentState, appendUserMessage, type AgentState } from "../src/lib/agentEvents";
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

describe("user messages and slash commands", () => {
  it("appendUserMessage appends a user-kind message with attachments", () => {
    const next = appendUserMessage(initialAgentState, "analyze this", ["report.csv"]);
    expect(next.messages).toEqual([
      { kind: "user", text: "analyze this", attachments: ["report.csv"] },
    ]);
  });

  it("session events store slashCommands and keep the previous list when absent", () => {
    let s = reduceAgent(initialAgentState, { type: "session", sessionId: "s1", slashCommands: ["/compact"] });
    expect(s.slashCommands).toEqual(["/compact"]);
    s = reduceAgent(s, { type: "session", sessionId: "s1" });
    expect(s.slashCommands).toEqual(["/compact"]);
  });

  it("normalizes SDK-style unprefixed command names to /-prefixed", () => {
    const s = reduceAgent(initialAgentState, {
      type: "session",
      sessionId: "s1",
      slashCommands: ["compact", "cost", "/review"],
    });
    expect(s.slashCommands).toEqual(["/compact", "/cost", "/review"]);
  });
});

describe("message reconciliation", () => {
  it("reconciles the sender's optimistic entry instead of appending a duplicate", () => {
    const optimistic = appendUserMessage(initialAgentState, "hello", ["a.png"], "turn-1");
    const next = reduceAgent(optimistic, {
      type: "message",
      author: "op@example.com",
      text: "hello\n\n[Attached files: /w/uploads/a.png]",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-1",
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].author).toBe("op@example.com");
    // Local text and chips win: the wire text is the prompt, with the paths appended.
    expect(next.messages[0].text).toBe("hello");
    expect(next.messages[0].attachments).toEqual(["a.png"]);
  });

  it("is idempotent when the same message arrives twice", () => {
    const optimistic = appendUserMessage(initialAgentState, "hello", undefined, "turn-1");
    const event = {
      type: "message" as const,
      author: "op@example.com",
      text: "hello",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-1",
    };
    const next = reduceAgent(reduceAgent(optimistic, event), event);
    expect(next.messages).toHaveLength(1);
  });

  it("appends a message whose turnId it does not own", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "what about the poller?",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-zoe",
    });
    expect(next.messages).toEqual([
      {
        kind: "user",
        text: "what about the poller?",
        author: "zoe@example.com",
        id: "turn-zoe",
      },
    ]);
  });

  it("renders another person's attachments as chips, not a raw path line", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "see this\n\n[Attached files: /w/uploads/z.png]",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-zoe",
    });
    expect(next.messages[0].text).toBe("see this");
    expect(next.messages[0].attachments).toEqual(["/w/uploads/z.png"]);
  });

  it("appends a message with no turnId", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "no turn id",
      ts: "2026-08-05T00:00:00Z",
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBeUndefined();
  });
});

describe("room state", () => {
  it("starts with nobody present and an empty queue", () => {
    expect(initialAgentState.presence).toEqual([]);
    expect(initialAgentState.queueDepth).toBe(0);
  });

  it("reduces a presence event into per-session state", () => {
    const next = reduceAgent(initialAgentState, {
      type: "presence",
      logins: ["op@example.com", "zoe@example.com"],
    });
    expect(next.presence).toEqual(["op@example.com", "zoe@example.com"]);
  });

  it("reduces a queue event into per-session state", () => {
    const next = reduceAgent(initialAgentState, { type: "queue", depth: 2 });
    expect(next.queueDepth).toBe(2);
  });

  it("leaves messages untouched when reducing room state", () => {
    const seeded = { ...initialAgentState, messages: [{ kind: "text" as const, text: "hi" }] };
    expect(reduceAgent(seeded, { type: "queue", depth: 1 }).messages).toBe(seeded.messages);
  });
});
