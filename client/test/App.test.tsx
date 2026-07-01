import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";

vi.mock("../src/lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ agentBase: "", dashboardBase: "" }),
  checkHealth: vi.fn(),
  setConfig: vi.fn(),
  openAgentStream: vi.fn(() => () => {}),
  sendMessage: vi.fn(),
  openRegistryStream: vi.fn(() => () => {}),
}));

describe("App", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the connection screen when no config is set", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /connect/i })).toBeTruthy();
  });
});
