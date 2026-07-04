import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>("../src/lib/tauri");
  return {
    ...actual, // keep agentBaseOf/dashboardBaseOf pure helpers
    getConfig: vi.fn().mockResolvedValue({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" }),
    checkHealth: vi.fn(),
    setConfig: vi.fn().mockResolvedValue(undefined),
    discoverHosts: vi.fn().mockResolvedValue({ hosts: [], scanned: 0, attempts: [] }),
    fetchManifest: vi.fn(),
    openAgentStream: vi.fn(() => () => {}),
    sendMessage: vi.fn(),
    openRegistryStream: vi.fn(() => () => {}),
    openPendingStream: vi.fn(() => () => {}),
    resolvePending: vi.fn(),
    openInfraPendingStream: vi.fn(() => () => {}),
    resolveInfraPending: vi.fn(),
  };
});

import { getConfig, setConfig } from "../src/lib/tauri";

describe("App", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the connection screen when no config is set", async () => {
    (getConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      baseUrl: "",
      agentPath: "/agent",
      dashboardPath: "/",
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /connect/i })).toBeTruthy();
  });

  it("disconnect clears the config and returns to the connection screen", async () => {
    (getConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      baseUrl: "https://box.ts.net",
      agentPath: "/agent",
      dashboardPath: "/",
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Connection" }));
    const btn = await screen.findByRole("button", { name: /disconnect/i });
    await userEvent.click(btn);
    expect(setConfig).toHaveBeenCalledWith({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" });
    expect(await screen.findByText(/connect rhumb/i)).toBeTruthy();
  });
});
