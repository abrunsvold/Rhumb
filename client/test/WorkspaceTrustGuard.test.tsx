import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";
import { openPendingStream, resolvePending } from "../src/lib/tauri";
import type { PendingItem } from "../src/lib/pendingStore";

// Trust is granted server-side only when resolvePending's fourth argument is
// true, and Workspace is the last place that argument is computed. The real
// ApprovalCard hardcodes `false` on its deny button, so a UI-driven test can
// never present Workspace with ("deny", true) — this file stubs the card to
// emit exactly that, pinning the `decision === "approve" && trust` guard.
// Without it, changing that expression to a bare `trust` passes every test.
vi.mock("../src/components/ApprovalCard", () => ({
  ApprovalCard: ({
    item,
    onResolve,
  }: {
    item: PendingItem;
    onResolve: (decision: "approve" | "deny", trust: boolean) => void;
  }) => (
    <div>
      <button onClick={() => onResolve("deny", true)}>deny-with-trust-{item.pendingId}</button>
      <button onClick={() => onResolve("approve", true)}>approve-with-trust-{item.pendingId}</button>
    </div>
  ),
}));

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn(() => () => {}),
  openSessionStream: vi.fn(() => () => {}),
  openRegistryStream: vi.fn(() => () => {}),
  openPendingStream: vi.fn(() => () => {}),
  openInfraPendingStream: vi.fn(() => () => {}),
  resolvePending: vi.fn().mockResolvedValue(undefined),
  resolveInfraPending: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  uploadFile: vi.fn(),
  getTranscript: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  getOntology: vi.fn().mockResolvedValue({ nodes: [], syncedAt: null, syncError: null }),
  renameSession: vi.fn(),
  archiveSession: vi.fn(),
}));

function setup() {
  const emit: { data?: (e: unknown) => void } = {};
  vi.mocked(openPendingStream).mockImplementation((_b, cb) => { emit.data = cb; return () => {}; });
  render(<Workspace agentBase="http://a:8787" dashboardBase="http://d:8788" onDisconnect={vi.fn()} />);
  act(() => {
    emit.data?.({
      type: "added",
      write: { pendingId: "p1", source: "printers", op: { kind: "update", table: "jobs" }, surfaceId: "farm" },
    });
  });
}

describe("Workspace trust guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never grants trust on a denial", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "deny-with-trust-p1" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "deny", false),
    );
  });

  it("grants trust on an approval that carries it", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "approve-with-trust-p1" }));
    await waitFor(() =>
      expect(resolvePending).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true),
    );
  });
});
