import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionMeta } from "../src/lib/types";

const sessions: SessionMeta[] = [
  { id: "s1", title: "Printer digest", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-02T00:00:00Z", preview: "…", archived: false },
  { id: "s2", title: "Ontology sync", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-01T12:00:00Z", preview: "…", archived: false },
];

vi.mock("../src/lib/tauri", () => ({
  listSessions: vi.fn(async () => sessions),
  renameSession: vi.fn().mockResolvedValue(undefined),
  archiveSession: vi.fn().mockResolvedValue(undefined),
}));

import { SessionsPanel } from "../src/components/SessionsPanel";
import { listSessions, renameSession, archiveSession } from "../src/lib/tauri";

beforeEach(() => vi.clearAllMocks());

function setup(tabs: any[] = []) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  render(<SessionsPanel agentBase="http://a:8787" tabs={tabs} onOpen={onOpen} onNew={onNew} />);
  return { onOpen, onNew };
}

describe("SessionsPanel", () => {
  it("lists sessions from the host and opens one on click", async () => {
    const { onOpen } = setup();
    // Get all buttons with "Printer digest" and click the one without aria-label (the session itself)
    const buttons = await screen.findAllByRole("button", { name: /printer digest/i });
    const sessionButton = buttons.find((btn) => !btn.getAttribute("aria-label"));
    await userEvent.click(sessionButton!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("New session triggers onNew", async () => {
    const { onNew } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /new session/i }));
    expect(onNew).toHaveBeenCalled();
  });

  it("renames inline and refreshes", async () => {
    setup();
    const buttons = await screen.findAllByRole("button", { name: /printer digest/i });
    const renameButton = buttons.find((btn) => btn.getAttribute("aria-label") === "Rename Printer digest");
    await userEvent.click(renameButton!);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Digest v2{Enter}");
    await waitFor(() => expect(renameSession).toHaveBeenCalledWith("http://a:8787", "s1", "Digest v2"));
    expect(listSessions).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it("archives and refreshes", async () => {
    setup();
    const buttons = await screen.findAllByRole("button", { name: /ontology sync/i });
    const archiveButton = buttons.find((btn) => btn.getAttribute("aria-label") === "Archive Ontology sync");
    await userEvent.click(archiveButton!);
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith("http://a:8787", "s2"));
  });

  it("shows running and unread badges from tab state", async () => {
    setup([
      { key: "s1", openTurns: 1, unread: false },
      { key: "s2", openTurns: 0, unread: true },
    ]);
    const buttons = await screen.findAllByRole("button", { name: /printer digest/i });
    const sessionButton = buttons.find((btn) => !btn.getAttribute("aria-label"));
    expect(sessionButton).toBeTruthy(); // ensure rendered
    expect(screen.getByLabelText("s1 running")).toBeTruthy();
    expect(screen.getByLabelText("s2 unread")).toBeTruthy();
  });
});
