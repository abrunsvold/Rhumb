import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";
import { openPendingStream, resolvePending } from "../src/lib/tauri";
import type { PendingItem, ResolvedItem } from "../src/lib/pendingStore";

// Trust is granted server-side only when resolvePending's fourth argument is
// true, and Workspace is the last place that argument is computed. The real
// ApprovalCard hardcodes `false` on its deny button, so a UI-driven test can
// never present Workspace with ("deny", true) — this file stubs the card to
// emit exactly that, pinning the `decision === "approve" && trust` guard.
// Without it, changing that expression to a bare `trust` passes every test.
vi.mock("../src/components/ApprovalCard", () => {
  const ApprovalCard = ({
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
  );
  // Mirrors the real queue's structure so the outcome lines still render —
  // only the card's decision surface is stubbed.
  const ApprovalQueue = ({
    pending,
    resolved,
    onResolve,
  }: {
    pending: PendingItem[];
    resolved: ResolvedItem[];
    onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void;
  }) => (
    <>
      {resolved.map((r, i) => (
        <div key={`${r.pendingId}:${i}`}>{r.outcome}</div>
      ))}
      {pending.map((p) => (
        <ApprovalCard key={p.pendingId} item={p} onResolve={(d, t) => onResolve(p, d, t)} />
      ))}
    </>
  );
  return { ApprovalCard, ApprovalQueue };
});

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

function setup(surfaceId: string | null = "farm") {
  const emit: { data?: (e: unknown) => void } = {};
  vi.mocked(openPendingStream).mockImplementation((_b, cb) => { emit.data = cb; return () => {}; });
  render(<Workspace agentBase="http://a:8787" dashboardBase="http://d:8788" onDisconnect={vi.fn()} />);
  act(() => {
    emit.data?.({
      type: "added",
      write: { pendingId: "p1", source: "printers", op: { kind: "update", table: "jobs" }, surfaceId },
    });
  });
}

const TRUST_GRANTED = "Approved, and this surface is now trusted for adds and edits.";
const NO_GRANT = "Approved — sent to the host to run.";

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
    expect(screen.getByText(TRUST_GRANTED)).toBeTruthy();
  });

  // The host writes a trust pair only when the pending carries a surfaceId
  // (dashboard-host/src/data/router.ts:102 gates on `pending?.surfaceId`).
  // Without one the grant is silently dropped, so reporting it would claim a
  // standing permission the server never recorded.
  it("never reports a trust grant for a pending with no surface", async () => {
    setup(null);
    await userEvent.click(await screen.findByRole("button", { name: "approve-with-trust-p1" }));
    await waitFor(() => expect(screen.getByText(NO_GRANT)).toBeTruthy());
    expect(screen.queryByText(TRUST_GRANTED)).toBeNull();
    expect(screen.queryByText(/trusted/i)).toBeNull();
  });
});
