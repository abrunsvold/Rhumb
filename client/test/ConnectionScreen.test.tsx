import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionScreen } from "../src/components/ConnectionScreen";

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>("../src/lib/tauri");
  return {
    ...actual, // keep agentBaseOf/dashboardBaseOf pure helpers
    getConfig: vi.fn().mockResolvedValue({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" }),
    setConfig: vi.fn().mockResolvedValue(undefined),
    checkHealth: vi.fn().mockResolvedValue(true),
    checkIdentity: vi.fn().mockResolvedValue(200),
    discoverHosts: vi.fn().mockResolvedValue([]),
    fetchManifest: vi.fn().mockResolvedValue({
      rhumb: true,
      version: "0.1.0",
      paths: { agent: "/agent", dashboard: "/" },
    }),
  };
});

import { checkHealth, checkIdentity, setConfig, discoverHosts, fetchManifest } from "../src/lib/tauri";

const CFG = { baseUrl: "https://box.ts.net", agentPath: "/agent", dashboardPath: "/" };

describe("ConnectionScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists discovered hosts and connects on click", async () => {
    (discoverHosts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { baseUrl: "https://box.ts.net", version: "0.1.0" },
    ]);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.click(await screen.findByRole("button", { name: /connect to box\.ts\.net/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CFG));
    expect(fetchManifest).toHaveBeenCalledWith("https://box.ts.net");
    expect(checkHealth).toHaveBeenCalledWith("https://box.ts.net/agent");
    expect(checkHealth).toHaveBeenCalledWith("https://box.ts.net");
    expect(setConfig).toHaveBeenCalledWith(CFG);
  });

  it("falls back to manual single-URL entry when discovery finds nothing", async () => {
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await screen.findByText(/no rhumb servers found/i);
    await userEvent.type(screen.getByLabelText(/server url/i), "https://box.ts.net{Enter}");
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CFG));
  });

  it("shows an error when the manifest probe fails", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockRejectedValueOnce("no manifest");
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(await screen.findByLabelText(/server url/i), "https://nope.ts.net{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/no rhumb server answered/i);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted device with an allowlist error, without persisting config", async () => {
    (checkIdentity as ReturnType<typeof vi.fn>).mockResolvedValueOnce(403);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(await screen.findByLabelText(/server url/i), "https://box.ts.net{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/RHUMB_ALLOWED_USERS/);
    expect(setConfig).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("shows an error when a health check fails", async () => {
    (checkHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(await screen.findByLabelText(/server url/i), "https://box.ts.net{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach/i);
    expect(onConnected).not.toHaveBeenCalled();
  });
});
