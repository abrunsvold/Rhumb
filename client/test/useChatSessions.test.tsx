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
});
