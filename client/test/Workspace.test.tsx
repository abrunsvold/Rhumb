import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
