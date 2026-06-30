import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEvent } from "../src/lib/types";
import { AgentPanel } from "../src/components/AgentPanel";

let capturedOnEvent: ((e: AgentEvent) => void) | null = null;

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_base: string, _turnId: string, onEvent: (e: AgentEvent) => void) => {
    capturedOnEvent = onEvent;
    return () => {};
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { openAgentStream, sendMessage } from "../src/lib/tauri";

describe("AgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEvent = null;
  });

  it("opens a stream then sends the message on submit, and renders streamed events", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);

    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // stream opened before send
    expect(openAgentStream).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const streamOrder = (openAgentStream as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const sendOrder = (sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(streamOrder).toBeLessThan(sendOrder);

    // a streamed result event renders
    capturedOnEvent?.({ type: "result", result: "the answer", isError: false });
    expect(await screen.findByText("the answer")).toBeTruthy();
  });
});
