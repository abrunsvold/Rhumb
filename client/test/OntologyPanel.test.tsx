import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OntologyPanel } from "../src/components/OntologyPanel";
import type { OntologySnapshot } from "../src/lib/types";

// No `vi.mock("../src/lib/tauri")` here: Task 13 lifted the fetch into
// Workspace, so this panel is pure — it renders whatever snapshot it is given.

const snap: OntologySnapshot = {
  syncedAt: "2026-07-09T12:00:00.000Z",
  syncError: null,
  nodes: [
    { type: "dashboard", id: "dashboard-spools", title: "spools", managed: "system", props: {}, relationships: [] },
    { type: "dashboard", id: "dashboard-ghost", title: "ghost", managed: "system", props: {}, relationships: [] },
    {
      type: "service", id: "service-poller", title: "Print poller", managed: "system",
      props: { host: "192.168.1.95", port: "3000", status: "healthy" },
      relationships: [{ edge: "runs-on", target: "container-105" }],
    },
    { type: "service", id: "service-api", title: "printer-api", managed: "system", props: {}, relationships: [] },
  ],
};

const surfaceTabs = [{ id: "spools", title: "spools", url: "/surfaces/spools/" }];

function mount(
  over: Partial<OntologySnapshot> = {},
  onSelectSurface = vi.fn(),
  onSelectNode = vi.fn(),
  selectedNodeId: string | null = null,
  error: string | null = null,
  onRefresh = vi.fn(),
) {
  render(
    <OntologyPanel
      snapshot={{ ...snap, ...over }}
      error={error}
      onRefresh={onRefresh}
      surfaceTabs={surfaceTabs}
      activeSurfaceId={null}
      selectedNodeId={selectedNodeId}
      onSelectSurface={onSelectSurface}
      onSelectNode={onSelectNode}
    />,
  );
  return { onSelectSurface, onSelectNode, onRefresh };
}

beforeEach(() => vi.clearAllMocks());

describe("OntologyPanel", () => {
  it("renders nodes from the supplied snapshot as a flat tree", async () => {
    mount();
    expect(await screen.findByText("spools")).toBeTruthy();
    expect(screen.getByText("ghost")).toBeTruthy();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("clicking a live dashboard selects the surface", async () => {
    const { onSelectSurface } = mount();
    await userEvent.click(await screen.findByText("spools"));
    expect(onSelectSurface).toHaveBeenCalledWith("spools");
  });

  it("clicking a dashboard whose surface isn't live routes to onSelectNode instead of being disabled", async () => {
    const { onSelectNode } = mount();
    await userEvent.click(await screen.findByText("ghost"));
    expect(onSelectNode).toHaveBeenCalledWith("dashboard-ghost");
  });

  it("routes a non-dashboard node to onSelectNode", async () => {
    const onSelectNode = vi.fn();
    render(
      <OntologyPanel
        snapshot={snap}
        error={null}
        onRefresh={vi.fn()}
        surfaceTabs={[]}
        activeSurfaceId={null}
        selectedNodeId={null}
        onSelectSurface={vi.fn()}
        onSelectNode={onSelectNode}
      />,
    );
    await userEvent.click(await screen.findByText("printer-api"));
    expect(onSelectNode).toHaveBeenCalledWith("service-api");
  });

  it("filters the tree", async () => {
    mount();
    await screen.findByText("spools");
    await userEvent.type(screen.getByPlaceholderText(/filter/i), "poller");
    expect(screen.queryByText("spools")).toBeNull();
    expect(screen.queryByText("ghost")).toBeNull();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("shows a sync-error banner", async () => {
    mount({ syncError: "projector broke" });
    expect(await screen.findByText(/projector broke/)).toBeTruthy();
  });

  it("shows the fetch error the owner passed down", async () => {
    render(
      <OntologyPanel
        snapshot={null}
        error="offline"
        onRefresh={vi.fn()}
        surfaceTabs={[]}
        activeSurfaceId={null}
        selectedNodeId={null}
        onSelectSurface={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );
    expect(await screen.findByText(/offline/)).toBeTruthy();
  });

  // `aria-current` means "the current item in this set" and must be unique.
  // Workspace clears `selectedNode` when a surface is picked but does NOT clear
  // `activeSurf` when a node is picked, so both a dashboard row and a node row
  // can be selected at once — and the node is what the right-hand column is
  // actually showing.
  it("marks exactly one row current when a node is selected while a surface is active", async () => {
    render(
      <OntologyPanel
        snapshot={snap}
        error={null}
        onRefresh={vi.fn()}
        surfaceTabs={surfaceTabs}
        activeSurfaceId="spools"
        selectedNodeId="service-api"
        onSelectSurface={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );
    await screen.findByText("spools");
    const current = document.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("printer-api");
  });

  // …and with no node selected the active surface is current again.
  it("marks the active surface current when no node is selected", async () => {
    render(
      <OntologyPanel
        snapshot={snap}
        error={null}
        onRefresh={vi.fn()}
        surfaceTabs={surfaceTabs}
        activeSurfaceId="spools"
        selectedNodeId={null}
        onSelectSurface={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );
    await screen.findByText("spools");
    const current = document.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("spools");
  });

  // The panel stopped fetching in Task 13; without a control wired to
  // onRefresh there is no way to re-sync the map short of restarting the app.
  it("asks the owner to re-sync when the refresh control is used", async () => {
    const { onRefresh } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Refresh map" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
