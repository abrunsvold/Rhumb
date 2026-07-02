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
  renameSession: vi.fn(),
  archiveSession: vi.fn(),
}));

function setup() {
  const onDisconnect = vi.fn();
  render(<Workspace agentBase="http://a:8787" dashboardBase="http://d:8788" onDisconnect={onDisconnect} />);
  return { onDisconnect };
}

describe("Workspace shell", () => {
  it("renders the rail with Sessions, Surfaces, and Connection buttons", () => {
    setup();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Surfaces" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connection" })).toBeTruthy();
  });

  it("gear panel shows hosts and Disconnect works; clicking the icon again collapses", async () => {
    const { onDisconnect } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.getByText("http://a:8787")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.queryByText("http://a:8787")).toBeNull();
  });

  it("opens with a draft chat tab ready to send", async () => {
    setup();
    expect(await screen.findByRole("tab", { name: /new session/i })).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("streams the registry and shows surfaces in the panel and canvas", async () => {
    const { openRegistryStream } = await import("../src/lib/tauri");
    setup();
    const cb = (openRegistryStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    act(() => cb({ surfaces: [{ id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));
    expect(await screen.findByRole("tab", { name: "Sales" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Surfaces" }));
    const salesButton = screen.getByRole("button", { name: /sales/i });
    expect(salesButton).toBeTruthy();
    expect(salesButton.getAttribute("aria-current")).toBe("true");
  });

  it("opens exactly one draft even if the mount effect double-fires", async () => {
    setup();
    const tabs = await screen.findAllByRole("tab", { name: /new session/i });
    expect(tabs).toHaveLength(1);
  });
});
