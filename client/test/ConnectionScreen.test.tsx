import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionScreen } from "../src/components/ConnectionScreen";

vi.mock("../src/lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ agentBase: "", dashboardBase: "" }),
  setConfig: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn().mockResolvedValue(true),
}));

import { checkHealth, setConfig } from "../src/lib/tauri";

describe("ConnectionScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls onConnected after both hosts pass health checks", async () => {
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(screen.getByLabelText(/agent host/i), "http://a:8787");
    await userEvent.type(screen.getByLabelText(/dashboard host/i), "http://d:8788");
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(checkHealth).toHaveBeenCalledWith("http://a:8787");
    expect(checkHealth).toHaveBeenCalledWith("http://d:8788");
    expect(setConfig).toHaveBeenCalledWith({ agentBase: "http://a:8787", dashboardBase: "http://d:8788" });
    expect(onConnected).toHaveBeenCalledWith({ agentBase: "http://a:8787", dashboardBase: "http://d:8788" });
  });

  it("shows an error and does not connect when a host fails", async () => {
    (checkHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(screen.getByLabelText(/agent host/i), "http://a:8787");
    await userEvent.type(screen.getByLabelText(/dashboard host/i), "http://d:8788");
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByText(/could not reach/i)).toBeTruthy();
  });
});
