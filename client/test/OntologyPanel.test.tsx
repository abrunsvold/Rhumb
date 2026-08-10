import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OntologyPanel } from "../src/components/OntologyPanel";
import { getOntology } from "../src/lib/tauri";
import type { OntologySnapshot } from "../src/lib/types";

vi.mock("../src/lib/tauri", () => ({ getOntology: vi.fn() }));

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
) {
  (getOntology as ReturnType<typeof vi.fn>).mockResolvedValue({ ...snap, ...over });
  render(
    <OntologyPanel
      agentBase="http://a"
      surfaceTabs={surfaceTabs}
      activeSurfaceId={null}
      selectedNodeId={selectedNodeId}
      onSelectSurface={onSelectSurface}
      onSelectNode={onSelectNode}
    />,
  );
  return { onSelectSurface, onSelectNode };
}

beforeEach(() => vi.clearAllMocks());

describe("OntologyPanel", () => {
  it("renders nodes from the fetched graph as a flat tree", async () => {
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
        agentBase="http://a"
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

  it("shows fetch errors", async () => {
    (getOntology as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <OntologyPanel
        agentBase="http://a"
        surfaceTabs={[]}
        activeSurfaceId={null}
        selectedNodeId={null}
        onSelectSurface={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );
    expect(await screen.findByText(/offline/)).toBeTruthy();
  });
});
