import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn(() => () => {}),
  openSessionStream: vi.fn(() => () => {}),
  openRegistryStream: vi.fn(() => () => {}),
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
