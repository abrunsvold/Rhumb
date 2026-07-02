import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatTabs } from "../src/components/ChatTabs";

const tabs = [
  { key: "s1", title: "One", openTurns: 1, unread: false, stale: false, historyNotice: false, agent: { sessionId: "s1", slashCommands: [], messages: [] } },
  { key: "s2", title: "Two", openTurns: 0, unread: true, stale: false, historyNotice: false, agent: { sessionId: "s2", slashCommands: [], messages: [] } },
] as any[];

describe("ChatTabs", () => {
  it("renders tabs with aria-selected, focuses on click, closes via the close button", async () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    render(<ChatTabs tabs={tabs} activeKey="s1" onFocus={onFocus} onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /one/i }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: /two/i }));
    expect(onFocus).toHaveBeenCalledWith("s2");
    await userEvent.click(screen.getByRole("button", { name: "Close Two" }));
    expect(onClose).toHaveBeenCalledWith("s2");
  });

  it("shows running and unread indicators", () => {
    render(<ChatTabs tabs={tabs} activeKey="s1" onFocus={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText("One running")).toBeTruthy();
    expect(screen.getByLabelText("Two unread")).toBeTruthy();
  });
});
