import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationDialog } from "../src/components/ConfirmationDialog";

let capturedOnPending: ((e: unknown) => void) | null = null;
const resolveSpy = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openPendingStream: vi.fn((_base: string, onPending: (e: unknown) => void) => {
    capturedOnPending = onPending;
    return () => {};
  }),
  resolvePending: (...args: unknown[]) => resolveSpy(...args),
}));

describe("ConfirmationDialog", () => {
  beforeEach(() => { vi.clearAllMocks(); capturedOnPending = null; });

  it("shows a pending write and approves with trust", async () => {
    render(<ConfirmationDialog dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p1", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });

    expect(await screen.findByText(/ops/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/trust this surface/i));
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true);
  });

  it("denies without trust", async () => {
    render(<ConfirmationDialog dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p2", source: "ops", op: { kind: "delete", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p2", "deny", false);
  });
});
