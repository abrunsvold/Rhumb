import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionMeta } from "../src/lib/types";

// Previews are distinct, and deliberately share no substring with either
// title, so tests can prove which field (title vs. preview) a query matched
// against — see "filters by title only" / "filters by preview only" below.
const sessions: SessionMeta[] = [
  { id: "s1", title: "Printer digest", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-02T00:00:00Z", preview: "Filament levels look low on spool 3", archived: false },
  { id: "s2", title: "Ontology sync", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-01T12:00:00Z", preview: "Traversal finished without errors", archived: false },
];

vi.mock("../src/lib/tauri", () => ({
  listSessions: vi.fn(async () => sessions),
  renameSession: vi.fn().mockResolvedValue(undefined),
  archiveSession: vi.fn().mockResolvedValue(undefined),
}));

import { SessionsPanel, groupSessions } from "../src/components/SessionsPanel";
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
    await userEvent.click(await screen.findByRole("button", { name: /\+ new/i }));
    expect(onNew).toHaveBeenCalled();
  });

  it("renames inline and refreshes", async () => {
    setup();
    const buttons = await screen.findAllByRole("button", { name: /printer digest/i });
    const renameButton = buttons.find((btn) => btn.getAttribute("aria-label") === "Rename Printer digest");
    await userEvent.click(renameButton!);
    // getByRole("textbox") is now ambiguous with the search input; the rename
    // field is the one pre-filled with the session's current title.
    const input = screen.getByDisplayValue("Printer digest");
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

  it("shows an inline error when the list fetch fails and clears it on recovery", async () => {
    (listSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("403"));
    setup();
    expect(await screen.findByText(/couldn't load sessions/i)).toBeTruthy();
  });

  it("refetches when the running-tab count drops", async () => {
    const { rerender } = render(
      <SessionsPanel agentBase="http://a:8787" tabs={[{ key: "s1", openTurns: 1, unread: false }]} onOpen={vi.fn()} onNew={vi.fn()} />,
    );
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    rerender(
      <SessionsPanel agentBase="http://a:8787" tabs={[{ key: "s1", openTurns: 0, unread: false }]} onOpen={vi.fn()} onNew={vi.fn()} />,
    );
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
  });

  it("filters the list and reports the match count", async () => {
    // uses the file's existing listSessions mock; ensure it resolves at least
    // two sessions with distinct titles before running this
    render(<SessionsPanel agentBase="http://a" tabs={[]} onOpen={vi.fn()} onNew={vi.fn()} />);
    await screen.findByText(/sessions$/);
    await userEvent.type(screen.getByLabelText("Search sessions"), "zzzznomatch");
    expect(screen.getByText("No session matches that.")).toBeTruthy();
  });

  it("filters by title only, keeping the matching row and dropping the other", async () => {
    render(<SessionsPanel agentBase="http://a" tabs={[]} onOpen={vi.fn()} onNew={vi.fn()} />);
    await screen.findByText(/sessions$/);
    // "printer" is only in s1's title — absent from both previews and s2's title.
    await userEvent.type(screen.getByLabelText("Search sessions"), "printer");
    expect(await screen.findByText("1 of 2 match")).toBeTruthy();
    expect(screen.getByText("Printer digest")).toBeTruthy();
    expect(screen.queryByText("Ontology sync")).toBeNull();
  });

  it("filters by preview only, keeping the matching row and dropping the other", async () => {
    render(<SessionsPanel agentBase="http://a" tabs={[]} onOpen={vi.fn()} onNew={vi.fn()} />);
    await screen.findByText(/sessions$/);
    // "spool" is only in s1's preview — absent from both titles and s2's preview.
    await userEvent.type(screen.getByLabelText("Search sessions"), "spool");
    expect(await screen.findByText("1 of 2 match")).toBeTruthy();
    expect(screen.getByText("Printer digest")).toBeTruthy();
    expect(screen.queryByText("Ontology sync")).toBeNull();
  });
});

describe("groupSessions", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const at = (iso: string) => ({
    id: iso, title: iso, createdAt: iso, lastActiveAt: iso, preview: "", archived: false,
  });

  it("buckets by age and drops empty buckets", () => {
    const groups = groupSessions(
      [at("2026-08-10T11:00:00.000Z"), at("2026-08-06T11:00:00.000Z")],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Previous 7 days"]);
  });

  it("puts anything older than 30 days in the last bucket", () => {
    const groups = groupSessions([at("2026-05-01T11:00:00.000Z")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Previous 30 days");
  });

  it("keeps host order within a bucket", () => {
    const groups = groupSessions(
      [at("2026-08-10T09:00:00.000Z"), at("2026-08-10T11:00:00.000Z")],
      now,
    );
    expect(groups[0].items.map((s) => s.id)).toEqual([
      "2026-08-10T09:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]);
  });
});
