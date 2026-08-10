import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "../src/components/ApprovalCard";
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

  it("offers no trust option for an infra action", () => {
    render(<ApprovalCard item={infra} onResolve={vi.fn()} />);
    expect(screen.queryByLabelText(/Trust this surface/)).toBeNull();
  });

  it("exposes the raw op for inspection", async () => {
    render(<ApprovalCard item={write} onResolve={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/"table": "jobs"/)).toBeTruthy();
  });
});
