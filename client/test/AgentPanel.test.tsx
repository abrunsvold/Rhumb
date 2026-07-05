import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPanel } from "../src/components/AgentPanel";
import { initialAgentState } from "../src/lib/agentEvents";

function tab(over: Partial<any> = {}) {
  return {
    key: "s1", title: "One", openTurns: 0, unread: false, stale: false,
    historyNotice: false, agent: initialAgentState, ...over,
  };
}

describe("AgentPanel (presentational)", () => {
  it("renders the transcript for its tab and forwards sends", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<AgentPanel tab={tab()} slashCommands={[]} onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
    expect(onSend).toHaveBeenCalledWith("hi", []);
  });

  it("shows thinking while the tab has open turns", () => {
    render(<AgentPanel tab={tab({ openTurns: 1 })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("shows a stale-stream notice", () => {
    render(<AgentPanel tab={tab({ stale: true })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it("shows a banner when session history could not be loaded", () => {
    render(<AgentPanel tab={tab({ historyNotice: true })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/history unavailable/i)).toBeTruthy();
  });

  it("shows no history banner by default", () => {
    render(<AgentPanel tab={tab()} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.queryByText(/history unavailable/i)).toBeNull();
  });
});
