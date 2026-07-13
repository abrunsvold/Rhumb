import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationDialog } from "../src/components/ConfirmationDialog";

let capturedOnPending: ((e: unknown) => void) | null = null;
let capturedInfra: ((e: unknown) => void) | null = null;
const resolveSpy = vi.fn();
const infraResolveSpy = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openPendingStream: vi.fn((_base: string, onPending: (e: unknown) => void) => {
    capturedOnPending = onPending;
    return () => {};
  }),
  resolvePending: (...args: unknown[]) => resolveSpy(...args),
  openInfraPendingStream: vi.fn((_b: string, on: (e: unknown) => void) => {
    capturedInfra = on;
    return () => {};
  }),
  resolveInfraPending: (...a: unknown[]) => infraResolveSpy(...a),
}));

describe("ConfirmationDialog", () => {
  beforeEach(() => { vi.clearAllMocks(); capturedOnPending = null; capturedInfra = null; });

  it("shows a pending write and approves with trust", async () => {
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p1", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });

    expect(await screen.findByText(/ops/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/trust this surface/i));
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true);
  });

  it("denies without trust", async () => {
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p2", source: "ops", op: { kind: "delete", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p2", "deny", false);
  });

  it("confirms an infra action via resolveInfraPending", async () => {
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedInfra?.({ type: "added", action: { pendingId: "a1", tool: "destroy_vm", input: { id: 9 } } });
    await screen.findByText(/destroy_vm/);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(infraResolveSpy).toHaveBeenCalledWith("http://a:8787", "a1", "approve");
  });
});

describe("ConfirmationDialog (watchdog proposals)", () => {
  beforeEach(() => { vi.clearAllMocks(); capturedOnPending = null; capturedInfra = null; });

  it("labels a watchdog proposal and omits the label for interactive actions", async () => {
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedInfra?.({ type: "added", action: { pendingId: "w1", tool: "start_service", input: { id: "poller" }, proposedBy: "watchdog" } });
    expect(await screen.findByText(/proposed by the watchdog/i)).toBeTruthy();

    capturedInfra?.({ type: "resolved", action: { pendingId: "w1" } });
    capturedInfra?.({ type: "added", action: { pendingId: "w2", tool: "destroy_vm", input: { id: 3 }, proposedBy: "interactive" } });
    expect(await screen.findByText(/destroy_vm/)).toBeTruthy();
    expect(screen.queryByText(/proposed by the watchdog/i)).toBeNull();
  });
});
