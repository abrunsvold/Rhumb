import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";
import {
  openRegistryStream,
  openSessionStream,
  openPendingStream,
  openInfraPendingStream,
  resolvePending,
  resolveInfraPending,
  getOntology,
  listSessions,
} from "../src/lib/tauri";
import type { OntologySnapshot, SessionMeta } from "../src/lib/types";

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn(() => () => {}),
  openSessionStream: vi.fn(() => () => {}),
  openRegistryStream: vi.fn(() => () => {}),
  // TopBar probes the agent host on a 15s interval; the workspace mounts it.
  checkHealthTimed: vi.fn().mockResolvedValue({ ok: true, ms: 12 }),
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
  // Call counts are asserted below (the ontology refresh), so usage data has to
  // start clean per test. `clearAllMocks` keeps the resolved values above.
  beforeEach(() => {
    vi.clearAllMocks();
    // One test seeds a real session; `mockResolvedValue` would leak into the
    // rest of the file, so restore the empty default here rather than there.
    vi.mocked(listSessions).mockResolvedValue([]);
  });

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
    expect(screen.getByPlaceholderText(/reply, or ask for something new/i)).toBeTruthy();
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

  // MAP is the only surface-selection path, and its rows come from the
  // ontology projection. A surface the registry streams but the projector has
  // not (or cannot) project must still be reachable — the registry auto-selects
  // only surfTabs[0], so without a fallback row every later surface is
  // registered, counted in SURFACES, and unopenable.
  it("keeps a registry surface selectable when the ontology has no node for it", async () => {
    setup();
    const cb = vi.mocked(openRegistryStream).mock.calls.at(-1)![1];
    act(() =>
      cb({
        surfaces: [
          { id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" },
          { id: "zz", title: "Spool log", url: "/surfaces/zz/", kind: "file", created: "", updated: "" },
        ],
      }),
    );
    // x1 is auto-selected; zz has no dashboard node in the ontology mock.
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe("http://d:8788/surfaces/x1/"),
    );

    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await userEvent.click(await screen.findByRole("button", { name: /spool log/i }));
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe("http://d:8788/surfaces/zz/"),
    );
  });

  // …and the same must hold when the ontology fetch failed outright: with no
  // snapshot at all, the registry list is the only truth the client has.
  it("keeps registry surfaces selectable when the ontology fetch failed", async () => {
    // Both the mount fetch and the MAP-open re-fetch fail; `Once` twice rather
    // than a persistent rejection so later tests keep the factory default.
    vi.mocked(getOntology)
      .mockRejectedValueOnce(new Error("agent unreachable"))
      .mockRejectedValueOnce(new Error("agent unreachable"));
    setup();
    const cb = vi.mocked(openRegistryStream).mock.calls.at(-1)![1];
    act(() =>
      cb({
        surfaces: [
          { id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" },
          { id: "zz", title: "Spool log", url: "/surfaces/zz/", kind: "file", created: "", updated: "" },
        ],
      }),
    );
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await userEvent.click(await screen.findByRole("button", { name: /spool log/i }));
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe("http://d:8788/surfaces/zz/"),
    );
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

  // Picking a surface has to drop the node selection, or the detail pane stays
  // pinned on the node and the surface the operator just clicked never shows.
  it("returns to the surface iframe when a live surface is picked after a node", async () => {
    setup();
    const cb = vi.mocked(openRegistryStream).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));
    await screen.findByText("Sales");

    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await userEvent.click(await screen.findByRole("button", { name: /printer-api/i }));
    expect(document.querySelector("iframe")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /sales/i }));
    await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe("http://d:8788/surfaces/x1/");
    expect(screen.queryByText("LXC 118")).toBeNull();
  });

  // The three-track grid IS the deliverable of this task, so assert the track
  // list and what each track holds — a wordmark plus a telemetry string is
  // equally true of a single-column stack.
  it("lays out the top bar, three columns, and the telemetry bar", async () => {
    setup();
    expect(screen.getByText("RHUMB")).toBeTruthy(); // top row
    expect(await screen.findByText("QUEUE clear")).toBeTruthy(); // bottom row
    await screen.findByPlaceholderText(/reply, or ask for something new/i);

    const grid = document.querySelector("div.grid") as HTMLElement;
    expect(grid).toBeTruthy();
    // jsdom does not run Tailwind, so getComputedStyle sees nothing. Read the
    // declared track list straight off the arbitrary-property class.
    const template = /\[grid-template-columns:([^\]]+)\]/.exec(grid.className)?.[1];
    expect(template).toBeTruthy();
    // Safe split: no track in this template contains an underscore.
    expect(template!.split("_")).toEqual([
      "272px",
      "minmax(320px,0.9fr)",
      "minmax(560px,1.3fr)",
    ]);

    const columns = Array.from(grid.children) as HTMLElement[];
    expect(columns).toHaveLength(3);
    expect(within(columns[0]).getByRole("tab", { name: "SESSIONS" })).toBeTruthy();
    expect(within(columns[1]).getByPlaceholderText(/reply, or ask for something new/i)).toBeTruthy();
    expect(within(columns[2]).getByRole("button", { name: /DETACH/ })).toBeTruthy();

    // `overflow-x-auto` on the grid forces the USED overflow-y to `auto` too
    // (CSS Overflow 3: a non-visible value on one axis promotes the other), so
    // the grid is a vertical scroll container whether or not that was intended.
    // It stays harmless only because every column caps its own height at the
    // row: `min-h-0` keeps the single implicit row from growing to its
    // max-content height, so the grid's scrollHeight never exceeds its
    // clientHeight and the inner `overflow-y-auto` regions do the scrolling.
    // Drop `min-h-0` from a column and the whole grid becomes the scroller.
    expect(grid.className).toContain("overflow-x-auto");
    for (const col of columns) expect(col.className).toContain("min-h-0");
  });

  // The top bar's numbers are computed HERE, not in TopBar: `turns` counts
  // user-kind messages only, and `messages.length` (which counts the agent's
  // replies too) is the plausible-looking way to get it wrong.
  it("hands the top bar the session title and the USER-turn count, not every message", async () => {
    const meta: SessionMeta = {
      id: "s7", title: "Printer digest", createdAt: "2026-07-01T00:00:00Z",
      lastActiveAt: "2026-07-02T00:00:00Z", preview: "spool 3", archived: false,
    };
    vi.mocked(listSessions).mockResolvedValue([meta]);
    setup();

    const rows = await screen.findAllByRole("button", { name: /printer digest/i });
    await userEvent.click(rows.find((b) => !b.getAttribute("aria-label"))!);

    // Two agent replies arrive on the session stream, so total messages and
    // user messages diverge.
    const onSession = vi.mocked(openSessionStream).mock.calls.at(-1)![2];
    act(() => {
      onSession({ type: "result", result: "spool 3 refilled", isError: false });
      onSession({ type: "result", result: "job resumed", isError: false });
    });

    await userEvent.type(
      screen.getByPlaceholderText(/reply, or ask for something new/i),
      "check the spools{Enter}",
    );

    // Scoped to the <header>: the title also appears in the chat tab strip.
    const bar = screen.getByRole("banner");
    await waitFor(() => expect(within(bar).getByText("1 turn")).toBeTruthy());
    expect(within(bar).getByText("Printer digest")).toBeTruthy();
    expect(within(bar).queryByText("3 turns")).toBeNull(); // messages.length
    expect(within(bar).queryByText("0 turns")).toBeNull(); // a hardcoded zero
  });

  // The registry `title` lost its home when the surface tab strip went away.
  // The breadcrumb shows ONTOLOGY titles, and agent-host's projector sets a
  // dashboard node's title to its own id — so the surface header read "x1"
  // where the operator published "Quarterly Sales".
  it("ends the surface breadcrumb with the registry title, not the ontology node title", async () => {
    setup();
    const cb = vi.mocked(openRegistryStream).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "x1", title: "Quarterly Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));

    const column = (document.querySelector("div.grid")!.children[2]) as HTMLElement;
    expect(await within(column).findByText("Quarterly Sales")).toBeTruthy();
    // The ontology node for the same surface is titled "Sales" in this mock;
    // it must not be what the breadcrumb terminates on.
    expect(within(column).queryByText("Sales")).toBeNull();
  });

  // …and with no ontology node at all — the mount fetch failed, or the surface
  // was published since the last sync — the breadcrumb must still name what is
  // on screen instead of rendering an empty strip.
  it("names the surface in the breadcrumb even when the ontology knows nothing about it", async () => {
    setup();
    const cb = vi.mocked(openRegistryStream).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "zz", title: "Spool log", url: "/surfaces/zz/", kind: "file", created: "", updated: "" }] }));

    const column = (document.querySelector("div.grid")!.children[2]) as HTMLElement;
    expect(await within(column).findByText("Spool log")).toBeTruthy();
  });

  it("counts registered surfaces and ontology nodes in the telemetry bar", async () => {
    // Held in an object so TypeScript does not narrow the captured callback to
    // `null` — it is assigned from inside the stream mock.
    const emit: { registry?: Parameters<typeof openRegistryStream>[1] } = {};
    vi.mocked(openRegistryStream).mockImplementation((_b, cb) => { emit.registry = cb; return () => {}; });
    setup();
    act(() => {
      emit.registry?.({ surfaces: [{ id: "x1", title: "Sales", url: "/s/x1", kind: "table", created: "", updated: "" }] });
    });
    // The count is a nested <span>, so the label element's own text node is
    // just "SURFACES " — a /SURFACES\s*1/ text query never matches. Assert on
    // the label element's full textContent instead.
    await waitFor(() => expect(screen.getByText(/SURFACES/).textContent).toBe("SURFACES 1"));
    await waitFor(() => expect(screen.getByText(/NODES/).textContent).toBe("NODES 2"));
  });

  // The panel no longer owns the fetch, so the only re-sync path is the map's
  // refresh control reaching back into Workspace. Without it an operator has to
  // restart the app to pick up a changed ontology.
  it("re-fetches the ontology from the map refresh control", async () => {
    setup();
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    // Opening the tab is itself a re-fetch (pinned below). Let it settle and
    // measure from there, so this test still says exactly what it always said:
    // the refresh control adds ONE more call, not zero and not two.
    await act(async () => {});
    const before = vi.mocked(getOntology).mock.calls.length;
    await userEvent.click(await screen.findByRole("button", { name: "Refresh map" }));
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(before + 1));
  });

  // The MAP tree is the ONLY surface-selection path and the snapshot was
  // otherwise fetched once, at mount. A surface published mid-session reached
  // `surfTabs` and the telemetry count but never the tree, with nothing on
  // screen saying so — Refresh compensates for stale node properties, not for
  // a surface being unreachable.
  it("re-fetches the ontology every time the MAP tab is opened", async () => {
    setup();
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("tab", { name: "SESSIONS" }));
    expect(getOntology).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(3));
  });

  // The other half of the same failure: when the mount fetch rejects there is
  // no snapshot, so the tree has no rows and NO surface can be selected at all
  // — only the auto-selected surfTabs[0] is viewable. Opening MAP must be able
  // to recover on its own.
  it("recovers a map left empty by a failed mount fetch when MAP is opened", async () => {
    vi.mocked(getOntology).mockRejectedValueOnce(new Error("agent unreachable"));
    setup();
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    expect(await screen.findByRole("button", { name: /printer-api/i })).toBeTruthy();
  });

  // Mount, opening MAP and the refresh control can all ask for this snapshot;
  // a second request while one is in flight only races the first to setState.
  it("does not stack a second ontology fetch while one is in flight", async () => {
    const held: { release?: (s: OntologySnapshot) => void } = {};
    vi.mocked(getOntology).mockImplementationOnce(
      () => new Promise<OntologySnapshot>((res) => { held.release = res; }),
    );
    setup();
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await userEvent.click(await screen.findByRole("button", { name: "Refresh map" }));
    expect(getOntology).toHaveBeenCalledTimes(1);

    await act(async () => { held.release!({ nodes: [], syncedAt: null, syncError: null }); });
    // …and the guard releases: the next open fetches again.
    await userEvent.click(screen.getByRole("tab", { name: "SESSIONS" }));
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await waitFor(() => expect(getOntology).toHaveBeenCalledTimes(2));
  });

  // A failed refresh must NOT blank the snapshot. Rendering "NODES 0" would be
  // an affirmative claim that the map is empty, which the client cannot
  // support — the honest report is the last successful sync plus a named error.
  it("keeps the last good ontology when a refresh fails, and names the error", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/NODES/).textContent).toBe("NODES 2"));

    // Opening MAP re-fetches, so the rejection is armed AFTER the tab is open;
    // otherwise the tab's own fetch would consume it and the refresh would
    // succeed, testing nothing.
    await userEvent.click(screen.getByRole("tab", { name: "MAP" }));
    await screen.findByRole("button", { name: "Refresh map" });
    vi.mocked(getOntology).mockRejectedValueOnce(new Error("agent unreachable"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh map" }));

    // The error reaches OntologyPanel through Workspace's `ontologyError`.
    expect(await screen.findByText(/sync problem: agent unreachable/)).toBeTruthy();
    // …and the counts and tree still describe the last sync that succeeded.
    expect(screen.getByText(/NODES/).textContent).toBe("NODES 2");
    expect(screen.getByRole("button", { name: /printer-api/i })).toBeTruthy();
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

  // The pendings are held server-side whether or not a chat tab is open, so
  // closing the last one must not strand them: an approval card the client
  // stops drawing is a write nobody can approve or deny.
  it("keeps the queue reachable after the last chat tab is closed", async () => {
    const emit = captureStreams();
    setup();
    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" })); });
    expect(await screen.findByText("Update rows in printers.jobs")).toBeTruthy();

    for (const close of await screen.findAllByRole("button", { name: /^Close / })) {
      await userEvent.click(close);
    }
    expect(screen.queryAllByRole("tab", { name: /new session/i })).toHaveLength(0);
    expect(screen.getByText(/open a session or start a new one/i)).toBeTruthy();

    // Still on screen, and still resolvable.
    expect(screen.getByText("Update rows in printers.jobs")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "approve", false),
    );
    expect(screen.getByText("Approved — sent to the host to run.")).toBeTruthy();
  });

  // `trust` is per-card useState; only the pendingId key keeps a ticked box
  // from sliding onto whichever pending takes the slot when an earlier one
  // resolves, which would grant standing trust on an op nobody saw.
  it("does not carry a ticked trust box from one pending onto the next", async () => {
    const emit = captureStreams();
    setup();
    act(() => {
      emit.data?.(dataWrite({ kind: "update", table: "jobs" }, "p1"));
      emit.data?.(dataWrite({ kind: "update", table: "spools" }, "p2"));
    });
    expect(await screen.findByText("Update rows in printers.jobs")).toBeTruthy();
    expect(screen.getByText("Update rows in printers.spools")).toBeTruthy();

    const boxes = screen.getAllByLabelText(/Trust this surface/);
    expect(boxes).toHaveLength(2);
    await userEvent.click(boxes[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true),
    );

    const remaining = screen.getAllByLabelText(/Trust this surface/);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p2", "approve", false),
    );
  });

  // The approval modal that used to carry a queue count is gone, so the
  // telemetry bar is the only place a held write is visible when the operator
  // is looking at another sidebar tab or has scrolled past the card.
  it("reports the held queue count in the telemetry bar and clears it on resolve", async () => {
    const emit = captureStreams();
    setup();
    expect(await screen.findByText("QUEUE clear")).toBeTruthy();

    act(() => { emit.data?.(dataWrite({ kind: "update", table: "jobs" }, "p1")); });
    await waitFor(() => expect(screen.getByText("QUEUE 1 held")).toBeTruthy());
    expect(screen.queryByText("QUEUE clear")).toBeNull();

    act(() => { emit.infra?.({ type: "added", action: { pendingId: "a1", tool: "grow_disk", input: {}, proposedBy: "watchdog" } }); });
    await waitFor(() => expect(screen.getByText("QUEUE 2 held")).toBeTruthy());

    await userEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(screen.getByText("QUEUE 1 held")).toBeTruthy());
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
