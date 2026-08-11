import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPanel } from "../src/components/AgentPanel";
import { initialAgentState } from "../src/lib/agentEvents";

const noApprovals = { pending: [], resolved: [], onResolve: () => {} };

function tab(over: Partial<any> = {}) {
  return {
    key: "s1", title: "One", openTurns: 0, unread: false, stale: false,
    historyNotice: false, agent: initialAgentState, ...over,
  };
}

describe("AgentPanel (presentational)", () => {
  it("renders the transcript for its tab and forwards sends", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<AgentPanel {...noApprovals} tab={tab()} slashCommands={[]} onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
    expect(onSend).toHaveBeenCalledWith("hi", []);
  });

  it("shows a busy indicator while the tab has open turns", () => {
    render(<AgentPanel {...noApprovals} tab={tab({ openTurns: 1 })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/working/i)).toBeTruthy();
  });

  it("shows a stale-stream notice", () => {
    render(<AgentPanel {...noApprovals} tab={tab({ stale: true })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });
});
