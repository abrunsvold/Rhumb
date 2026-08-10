import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";
import {
  openPendingStream,
  openInfraPendingStream,
  resolvePending,
  resolveInfraPending,
} from "../src/lib/tauri";

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn(() => () => {}),
  openSessionStream: vi.fn(() => () => {}),
  openRegistryStream: vi.fn(() => () => {}),
  openPendingStream: vi.fn(() => () => {}),
  openInfraPendingStream: vi.fn(() => () => {}),
  resolvePending: vi.fn().mockResolvedValue(undefined),
  resolveInfraPending: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  uploadFile: vi.fn(),
  getTranscript: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  getOntology: vi.fn().mockResolvedValue({
    nodes: [
      { type: "dashboard", id: "dashboard-x1", title: "Sales", managed: "system", props: {}, relationships: [] },
      {
        type: "service",
        id: "service-api",
        title: "printer-api",
        managed: "system",
        props: { container: "LXC 118" },
        relationships: [],
      },
    ],
    syncedAt: "2026-07-09T12:00:00.000Z",
    syncError: null,
  }),
  renameSession: vi.fn(),
  archiveSession: vi.fn(),
}));

function setup() {
  const onDisconnect = vi.fn();
  render(<Workspace agentBase="http://a:8787" dashboardBase="http://d:8788" onDisconnect={onDisconnect} />);
  return { onDisconnect };
}

describe("Workspace shell", () => {
  it("renders the sidebar tabs", () => {
    setup();
    expect(screen.getByRole("tab", { name: "SESSIONS" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MAP" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "HOST" })).toBeTruthy();
  });

  it("host tab shows both hosts and Disconnect works", async () => {
    const { onDisconnect } = setup();
    await userEvent.click(screen.getByRole("tab", { name: "HOST" }));
    expect(screen.getByText("http://a:8787")).toBeTruthy();
    expect(screen.getByText("http://d:8788")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "DISCONNECT" }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("opens with a draft chat tab ready to send", async () => {
    setup();
    expect(await screen.findByRole("tab", { name: /new session/i })).toBeTruthy();
    // getByRole("textbox") is now ambiguous with the sessions search input
    // (SessionsPanel task 3); target the composer by its placeholder instead.
    expect(screen.getByPlaceholderText(/message the agent/i)).toBeTruthy();
  });

  it("streams the registry and shows surfaces in the panel and canvas", async () => {
    const { openRegistryStream } = await import("../src/lib/tauri");
    setup();
    const cb = (openRegistryStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));
    // Surface selection now lives in the MAP sidebar tab (Task 6); the canvas
    // column shows the active surface via the SurfaceFrame lineage breadcrumb
    // instead of its own tab strip.
    expect(await screen.findByText("Sales")).toBeTruthy();
    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("http://d:8788/surfaces/x1/");
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    const salesButton = await screen.findByRole("button", { name: /sales/i });
    expect(salesButton).toBeTruthy();
    expect(salesButton.getAttribute("aria-current")).toBe("true");
  });

  it("opens exactly one draft even if the mount effect double-fires", async () => {
    setup();
    const tabs = await screen.findAllByRole("tab", { name: /new session/i });
    expect(tabs).toHaveLength(1);
  });

  it("shows node detail instead of the surface iframe when a non-dashboard node is selected", async () => {
    const { openRegistryStream } = await import("../src/lib/tauri");
    setup();
    const cb = (openRegistryStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));
    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    const nodeButton = await screen.findByRole("button", { name: /printer-api/i });
    await userEvent.click(nodeButton);

    expect(document.querySelector("iframe")).toBeNull();
    // "printer-api" now appears twice — once in the MAP list, once as the
    // detail pane title — so assert on detail-only content instead.
    expect(screen.getByText("container")).toBeTruthy();
    expect(screen.getByText("LXC 118")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /DETACH/ })).toBeNull();
  });
});

describe("Workspace approvals (inline in the transcript)", () => {
  beforeEach(() => vi.clearAllMocks());

  // Held in an object so TypeScript does not narrow the captured callback to
  // `null` — it is assigned from inside the stream mock.
  function captureStreams() {
    const emit: { data?: (e: unknown) => void; infra?: (e: unknown) => void } = {};
    vi.mocked(openPendingStream).mockImplementation((_b, cb) => { emit.data = cb; return () => {}; });
    vi.mocked(openInfraPendingStream).mockImplementation((_b, cb) => { emit.infra = cb; return () => {}; });
    return emit;
  }

  const dataWrite = (op: unknown, pendingId = "p1") => ({
    type: "added",
    write: { pendingId, source: "printers", op, surfaceId: "farm" },
  });

  it("renders a pending write in the transcript and resolves it in place", async () => {
    const emit = captureStreams();
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" })); });

    expect(await screen.findByText("Update rows in printers.jobs")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    // Pinned wording: a resolved call means the host accepted the decision, not
    // that the write ran. Anything claiming execution overclaims.
    await waitFor(() => expect(screen.getByText("Approved — sent to the host to run.")).toBeTruthy());
    expect(screen.queryByText(/executed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "approve", false);
  });

  it("grants trust only when an approval carries it", async () => {
    const emit = captureStreams();
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" })); });
    await screen.findByText("Update rows in printers.jobs");

    await userEvent.click(screen.getByLabelText(/Trust this surface/));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true),
    );
    // The trust pair is written server-side inside the same resolve call, so a
    // successful return does mean trust was granted — this wording is accurate.
    expect(screen.getByText("Approved, and this surface is now trusted for adds and edits.")).toBeTruthy();
  });

  // A denial must never grant trust: the checkbox qualifies an approval only.
  it("never grants trust on a denial, even with the box checked", async () => {
    const emit = captureStreams();
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" })); });
    await screen.findByText("Update rows in printers.jobs");

    await userEvent.click(screen.getByLabelText(/Trust this surface/));
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "deny", false),
    );
    expect(vi.mocked(resolvePending).mock.calls.every((c) => c[3] === false)).toBe(true);
  });

  // The host never confirmed the decision, so the operator must still be able
  // to retry: dropping the card here would hide a write that is still queued.
  it("keeps the pending on screen when the host rejects the resolve", async () => {
    const emit = captureStreams();
    vi.mocked(resolvePending).mockRejectedValueOnce(new Error("host unreachable"));
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" })); });
    await screen.findByText("Update rows in printers.jobs");

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(/Could not resolve — host unreachable/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByText(/^Approved/)).toBeNull();
  });

  it("resolves an infra action with no trust concept at all", async () => {
    const emit = captureStreams();
    setup();
    act(() => {
      emit.infra?.({
        type: "added",
        action: { pendingId: "a1", tool: "grow_disk", input: { size: "8G" }, proposedBy: "watchdog" },
      });
    });

    expect(await screen.findByText("Run grow_disk (proposed by the watchdog)")).toBeTruthy();
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolveInfraPending).toHaveBeenCalledWith("http://a:8787", "a1", "approve"));
    expect(vi.mocked(resolveInfraPending).mock.calls[0]).toHaveLength(3);
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it("offers no trust checkbox for a delete and says why", async () => {
    const emit = captureStreams();
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "delete", table: "jobs" }, "p9")); });

    expect(await screen.findByText("Delete rows from printers.jobs")).toBeTruthy();
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
    expect(screen.getByText(/deletions always come back for approval/i)).toBeTruthy();
  });
});
