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
  ],
};

const surfaceTabs = [{ id: "spools", title: "spools", url: "/surfaces/spools/" }];

function mount(over: Partial<OntologySnapshot> = {}, onSelect = vi.fn()) {
  (getOntology as ReturnType<typeof vi.fn>).mockResolvedValue({ ...snap, ...over });
  render(
    <OntologyPanel agentBase="http://a" surfaceTabs={surfaceTabs} activeSurfaceId={null} onSelectSurface={onSelect} />,
  );
  return onSelect;
}

beforeEach(() => vi.clearAllMocks());

describe("OntologyPanel", () => {
  it("renders sections from the fetched graph", async () => {
    mount();
    expect(await screen.findByText("Dashboards")).toBeTruthy();
    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("clicking a live dashboard selects the surface; dead ones are disabled", async () => {
    const onSelect = mount();
    await userEvent.click(await screen.findByRole("button", { name: "spools" }));
    expect(onSelect).toHaveBeenCalledWith("spools");
    expect((screen.getByRole("button", { name: "ghost" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("expands a non-dashboard node into a detail card", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Print poller/ }));
    expect(screen.getByText(/192\.168\.1\.95/)).toBeTruthy();
    expect(screen.getByText(/runs-on → container-105/)).toBeTruthy();
  });

  it("filters all sections", async () => {
    mount();
    await screen.findByText("Dashboards");
    await userEvent.type(screen.getByPlaceholderText(/filter/i), "poller");
    expect(screen.queryByText("Dashboards")).toBeNull();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("shows a sync-error banner", async () => {
    mount({ syncError: "projector broke" });
    expect(await screen.findByText(/projector broke/)).toBeTruthy();
  });

  it("shows fetch errors", async () => {
    (getOntology as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <OntologyPanel agentBase="http://a" surfaceTabs={[]} activeSurfaceId={null} onSelectSurface={vi.fn()} />,
    );
    expect(await screen.findByText(/offline/)).toBeTruthy();
  });
});
