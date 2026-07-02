import { describe, it, expect } from "vitest";
import {
  emptyStore, openTab, closeTab, focusTab, reduceEvent,
  addUserMessage, bumpTurns, promoteDraft, setStale,
} from "../src/lib/chatStore";

describe("chatStore", () => {
  it("openTab adds a focused tab seeded with history and focusing twice is a no-op", () => {
    let s = openTab(emptyStore, "s1", "First", [{ kind: "user", text: "old" }]);
    expect(s.activeKey).toBe("s1");
    expect(s.tabs[0].agent.messages).toEqual([{ kind: "user", text: "old" }]);
    expect(s.tabs[0].agent.sessionId).toBe("s1"); // resumed sends continue the session
    const again = openTab(s, "s1", "First");
    expect(again.tabs).toHaveLength(1);
  });

  it("draft tabs start with a null sessionId", () => {
    const s = openTab(emptyStore, "draft:x", "New session");
    expect(s.tabs[0].agent.sessionId).toBeNull();
  });

  it("events reduce into the right tab and set unread only when unfocused", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = openTab(s, "s2", "Two"); // s2 focused now
    s = reduceEvent(s, "s1", { type: "result", result: "done", isError: false });
    const t1 = s.tabs.find((t) => t.key === "s1")!;
    expect(t1.agent.messages).toHaveLength(1);
    expect(t1.unread).toBe(true);
    s = focusTab(s, "s1");
    expect(s.tabs.find((t) => t.key === "s1")!.unread).toBe(false);
    // focused tab never marks unread
    s = reduceEvent(s, "s1", { type: "error", message: "x" });
    expect(s.tabs.find((t) => t.key === "s1")!.unread).toBe(false);
  });

  it("bumpTurns floors at zero and closeTab picks a neighbor focus", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = bumpTurns(s, "s1", -1);
    expect(s.tabs[0].openTurns).toBe(0);
    s = openTab(s, "s2", "Two");
    s = closeTab(s, "s2");
    expect(s.activeKey).toBe("s1");
    expect(s.tabs).toHaveLength(1);
  });

  it("promoteDraft re-keys a draft tab and keeps its state", () => {
    let s = openTab(emptyStore, "draft:tmp1", "New session");
    s = addUserMessage(s, "draft:tmp1", "hello", []);
    s = promoteDraft(s, "draft:tmp1", "real-id");
    expect(s.tabs[0].key).toBe("real-id");
    expect(s.activeKey).toBe("real-id");
    expect(s.tabs[0].agent.messages[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  it("setStale flags a tab", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = setStale(s, "s1", true);
    expect(s.tabs[0].stale).toBe(true);
  });
});
