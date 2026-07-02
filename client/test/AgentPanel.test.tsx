import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEvent } from "../src/lib/types";
import { AgentPanel } from "../src/components/AgentPanel";

let capturedOnEvent: ((e: AgentEvent) => void) | null = null;
const stopSpy = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_base: string, _turnId: string, onEvent: (e: AgentEvent) => void) => {
    capturedOnEvent = onEvent;
    return stopSpy;
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue("uploads/data.csv"),
}));

import { openAgentStream, sendMessage, uploadFile } from "../src/lib/tauri";

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

  it("stops the stream when the turn's result arrives", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);
    await userEvent.type(screen.getByRole("textbox"), "hi");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    capturedOnEvent?.({ type: "result", result: "x", isError: false });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the submitted message as a user bubble immediately", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);
    await userEvent.type(screen.getByRole("textbox"), "what is up{Enter}");
    const bubble = await screen.findByText("what is up");
    expect(bubble.closest("[data-kind]")?.getAttribute("data-kind")).toBe("user");
  });

  it("shows thinking while a turn is open and clears it on result", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);
    await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
    expect(await screen.findByText(/thinking/i)).toBeTruthy();
    capturedOnEvent?.({ type: "result", result: "done", isError: false });
    await waitFor(() => expect(screen.queryByText(/thinking/i)).toBeNull());
  });

  it("uploads staged files and appends the attached-files block to the prompt", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);
    const file = new File(["a,b"], "data.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    await screen.findByText(/data\.csv/);
    await userEvent.type(screen.getByRole("textbox"), "analyze{Enter}");
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith("http://a:8787", "data.csv", btoa("a,b")));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        "http://a:8787",
        expect.any(String),
        "analyze\n\n[Attached files: uploads/data.csv]",
        undefined,
      ),
    );
  });

  it("surfaces an upload failure and keeps the draft", async () => {
    (uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("413"));
    render(<AgentPanel agentBase="http://a:8787" />);
    const file = new File(["a,b"], "data.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    await screen.findByText(/data\.csv/);
    await userEvent.type(screen.getByRole("textbox"), "analyze{Enter}");
    expect(await screen.findByText(/upload failed/i)).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("analyze");
  });
});
