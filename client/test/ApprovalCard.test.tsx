import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard, ApprovalQueue } from "../src/components/ApprovalCard";
import type { PendingItem } from "../src/lib/pendingStore";

const write: PendingItem = {
  origin: "data", pendingId: "p1", source: "printers",
  op: { kind: "update", table: "jobs", where: { id: 1 }, values: { material: "PLA" } },
  surfaceId: "printer-farm",
};

const del: PendingItem = { ...write, pendingId: "p2", op: { kind: "delete", table: "jobs", where: { id: 1 } } };
const infra: PendingItem = { origin: "infra", pendingId: "p3", tool: "grow_disk", op: { size: "8G" } };

describe("ApprovalCard", () => {
  it("shows the summary and the guardrail note for a data write", () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    expect(screen.getByText("Update rows in printers.jobs")).toBeTruthy();
    expect(screen.getByText(/printer-farm/)).toBeTruthy();
  });

  it("approves without trust by default", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenCalledWith("approve", false);
  });

  it("passes the trust flag when the box is checked", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByLabelText(/Trust this surface/));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenCalledWith("approve", true);
  });

  it("denies", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(onResolve).toHaveBeenCalledWith("deny", false);
  });

  // A denial must never grant trust, even with the box ticked: the checkbox is
  // an approval qualifier, not a standing preference.
  it("never asks for trust on a denial, even with the box checked", async () => {
    const onResolve = vi.fn();
    render(<ApprovalCard item={write} onResolve={onResolve} />);
    await userEvent.click(screen.getByLabelText(/Trust this surface/));
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(onResolve).toHaveBeenCalledWith("deny", false);
  });

  it("warns that a delete is not covered by trust", () => {
    render(<ApprovalCard item={del} onResolve={vi.fn()} />);
    expect(screen.getByText(/deletions always come back for approval/i)).toBeTruthy();
  });

  // The server re-gates a DELETE even on a trusted surface; offering the box
  // here would promise a bypass that does not exist.
  it("offers no trust option for a delete", () => {
    render(<ApprovalCard item={del} onResolve={vi.fn()} />);
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
  });

  // The host writes a trust pair only when the pending carries a surfaceId
  // (dashboard-host/src/data/router.ts gates on `pending?.surfaceId`), so
  // offering the box without one promises a grant the server drops.
  it("offers no trust option for a data write with no surface", () => {
    render(<ApprovalCard item={{ ...write, surfaceId: null }} onResolve={vi.fn()} />);
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
  });

  it("offers no trust option for an infra action", () => {
    render(<ApprovalCard item={infra} onResolve={vi.fn()} />);
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
  });

  it("exposes the raw op for inspection", async () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/"table": "jobs"/)).toBeTruthy();
  });

  // The ConfirmationDialog this card replaced was a `role="dialog"` with an
  // aria-label; nothing took over its announcement, so a pending write reached
  // a screen-reader user as an unnamed div full of buttons.
  it("is a named group so the ask is announced before its buttons", () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Update rows in printers.jobs" });
    expect(within(group).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("names an infra group by the same summary it displays", () => {
    render(<ApprovalCard item={infra} onResolve={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Run grow_disk" })).toBeTruthy();
  });
});

describe("ApprovalQueue", () => {
  // Pendings arrive unprompted while the operator is doing something else, so
  // the region they land in has to be polite-live.
  it("puts the cards in a polite live region", () => {
    render(<ApprovalQueue pending={[write]} resolved={[]} onResolve={vi.fn()} />);
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(within(region as HTMLElement).getByRole("group", { name: "Update rows in printers.jobs" })).toBeTruthy();
  });

  // A live region announces reliably only when it pre-exists its content, so
  // the wrapper stays mounted with nothing queued (and out of flow via
  // `empty:hidden`) rather than appearing along with the first card.
  it("keeps the live region mounted when the queue is empty", () => {
    render(<ApprovalQueue pending={[]} resolved={[]} onResolve={vi.fn()} />);
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it("also announces the resolved outcomes", () => {
    render(
      <ApprovalQueue
        pending={[]}
        resolved={[{ pendingId: "p1", summary: "Update rows in printers.jobs", outcome: "Approved — sent to the host to run." }]}
        onResolve={vi.fn()}
      />,
    );
    const region = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(within(region).getByText("Approved — sent to the host to run.")).toBeTruthy();
  });
});
