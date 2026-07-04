import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AgentEvent } from "../src/lib/types";

const turnHandlers = new Map<string, (e: AgentEvent) => void>();
const sessionHandlers = new Map<string, (e: unknown) => void>();
const stopTurn = vi.fn();
const stopSession = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_b: string, turnId: string, on: (e: AgentEvent) => void) => {
    turnHandlers.set(turnId, on);
    return stopTurn;
  }),
  openSessionStream: vi.fn((_b: string, sessionId: string, on: (e: unknown) => void) => {
    sessionHandlers.set(sessionId, on);
    return stopSession;
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue("uploads/f.txt"),
  getTranscript: vi.fn().mockResolvedValue([{ kind: "user", text: "from history" }]),
}));

import { useChatSessions } from "../src/hooks/useChatSessions";
import { getTranscript, openSessionStream, sendMessage } from "../src/lib/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  turnHandlers.clear();
  sessionHandlers.clear();
});

describe("useChatSessions", () => {
  it("openSession hydrates history then attaches a live stream", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "Old" }));
    expect(getTranscript).toHaveBeenCalledWith("http://a:8787", "s1");
    expect(openSessionStream).toHaveBeenCalledWith("http://a:8787", "s1", expect.any(Function));
    expect(result.current.store.tabs[0].agent.messages[0]).toEqual({ kind: "user", text: "from history" });
    act(() => sessionHandlers.get("s1")!({ type: "result", result: "live", isError: false }));
    expect(result.current.store.tabs[0].agent.messages).toHaveLength(2);
  });

  it("transcript failure opens the tab with a history notice", async () => {
    (getTranscript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("404"));
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s2", title: "NoHist" }));
    expect(result.current.store.tabs[0].agent.messages[0].text).toMatch(/history unavailable/i);
    expect(result.current.store.tabs[0].historyNotice).toBe(true);
  });

  it("a draft promotes to the real session id on the first session event", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    expect(draftKey).toMatch(/^draft:/);
    await act(() => result.current.send(draftKey, "hello", []));
    const turnOn = [...turnHandlers.values()][0];
    act(() => turnOn({ type: "session", sessionId: "real-1" }));
    expect(result.current.store.tabs[0].key).toBe("real-1");
    expect(openSessionStream).toHaveBeenCalledWith("http://a:8787", "real-1", expect.any(Function));
  });

  it("a promoted draft keeps sending on the real session id (no forked session on 2nd send)", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    await act(() => result.current.send(draftKey, "hello", []));
    const turnOn = [...turnHandlers.values()][0];
    act(() => turnOn({ type: "session", sessionId: "real-1" }));
    act(() => turnOn({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].key).toBe("real-1");

    await act(() => result.current.send("real-1", "again", []));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith(
        "http://a:8787", expect.any(String), "again", "real-1",
      ),
    );
  });

  it("promotion refreshes the tab title from the sent prompt", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    expect(result.current.store.tabs[0].title).toBe("New session");
    await act(() => result.current.send(draftKey, "hello there", []));
    const turnOn = [...turnHandlers.values()][0];
    act(() => turnOn({ type: "session", sessionId: "real-2" }));
    expect(result.current.store.tabs[0].key).toBe("real-2");
    expect(result.current.store.tabs[0].title).toBe("hello there");
  });

  it("turn output still renders while the session stream is stale", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    act(() => sessionHandlers.get("s1")!({ type: "stream_closed" }));
    expect(result.current.store.tabs.find((t) => t.key === "s1")!.stale).toBe(true);

    await act(() => result.current.send("s1", "ping", []));
    // measure AFTER the user echo bubble was appended by send(), so this
    // isolates whether the turn stream's own result content gets reduced
    const before = result.current.store.tabs.find((t) => t.key === "s1")!.agent.messages.length;
    const turnOn = [...turnHandlers.values()].at(-1)!;
    act(() => turnOn({ type: "result", result: "pong", isError: false }));
    const after = result.current.store.tabs.find((t) => t.key === "s1")!.agent.messages.length;
    expect(after).toBeGreaterThan(before);
  });

  it("background session events mark unread; stream_closed marks stale", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    await act(() => result.current.openSession({ id: "s2", title: "Two" }));
    act(() => sessionHandlers.get("s1")!({ type: "result", result: "bg", isError: false }));
    expect(result.current.store.tabs.find((t) => t.key === "s1")!.unread).toBe(true);
    act(() => sessionHandlers.get("s1")!({ type: "stream_closed" }));
    expect(result.current.store.tabs.find((t) => t.key === "s1")!.stale).toBe(true);
  });

  it("send uploads, appends the attached-files block, and resolves true", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    let ok = false;
    await act(async () => {
      ok = await result.current.send("s1", "look", [{ name: "f.txt", contentBase64: "aGk=" }]);
    });
    expect(ok).toBe(true);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        "http://a:8787", expect.any(String), "look\n\n[Attached files: uploads/f.txt]", "s1",
      ),
    );
  });

  it("close stops the session stream and removes the tab", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    act(() => result.current.close("s1"));
    expect(stopSession).toHaveBeenCalled();
    expect(result.current.store.tabs).toHaveLength(0);
  });

  it("sendMessage rejection surfaces a send failure, cleans up the turn, and returns false", async () => {
    (sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host down"));
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const key = result.current.store.tabs[0].key;
    let ok = true;
    await act(async () => {
      ok = await result.current.send(key, "hello", []);
    });
    expect(ok).toBe(false);
    const tab = result.current.store.tabs[0];
    expect(tab.openTurns).toBe(0);
    expect(tab.agent.messages.some((m) => m.kind === "error" && /send failed: host down/i.test(m.text))).toBe(true);
    // user bubble still appended before the failure
    expect(tab.agent.messages.some((m) => m.kind === "user" && m.text === "hello")).toBe(true);
  });

  it("a result event on the turn stream decrements openTurns (thinking clears)", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const key = result.current.store.tabs[0].key;
    await act(async () => {
      await result.current.send(key, "hi", []);
    });
    expect(result.current.store.tabs[0].openTurns).toBe(1);
    const turnOn = [...turnHandlers.values()].at(-1)!;
    act(() => turnOn({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
    // and delivering the same result again must not double-decrement below zero or re-fire cleanup
    act(() => turnOn({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
  });

  it("clears busy when the terminal result arrives on the SESSION stream, not the turn stream", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    await act(async () => {
      await result.current.send(draftKey, "hello", []);
    });
    const turnId = [...turnHandlers.keys()][0];
    act(() => turnHandlers.get(turnId)!({ type: "session", sessionId: "real-3" }));
    expect(result.current.store.tabs[0].key).toBe("real-3");
    expect(result.current.store.tabs[0].openTurns).toBe(1);

    // the turn stream goes silent; the session stream delivers the terminal event instead
    act(() => sessionHandlers.get("real-3")!({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
  });

  it("clears busy when the turn stream closes with no terminal event", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const key = result.current.store.tabs[0].key;
    await act(async () => {
      await result.current.send(key, "hi", []);
    });
    expect(result.current.store.tabs[0].openTurns).toBe(1);
    const turnOn = [...turnHandlers.values()].at(-1)!;
    act(() => turnOn({ type: "stream_closed" } as unknown as AgentEvent));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
  });

  it("does not double-decrement if result arrives on both streams", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    await act(async () => {
      await result.current.send(draftKey, "hello", []);
    });
    const turnId = [...turnHandlers.keys()][0];
    act(() => turnHandlers.get(turnId)!({ type: "session", sessionId: "real-4" }));
    expect(result.current.store.tabs[0].openTurns).toBe(1);

    act(() => turnHandlers.get(turnId)!({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
    act(() => sessionHandlers.get("real-4")!({ type: "result", result: "done", isError: false }));
    expect(result.current.store.tabs[0].openTurns).toBe(0);
  });
});
