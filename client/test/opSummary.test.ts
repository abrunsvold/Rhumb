import { describe, it, expect } from "vitest";
import { summarizeOp } from "../src/lib/opSummary";
import type { PendingItem } from "../src/lib/pendingStore";

const data = (op: unknown, surfaceId: string | null = "printer-farm"): PendingItem => ({
  origin: "data", pendingId: "p1", source: "printers", op, surfaceId,
});

describe("summarizeOp", () => {
  it("describes an insert", () => {
    expect(summarizeOp(data({ kind: "insert", table: "jobs", values: { a: 1 } })))
      .toBe("Add a row to printers.jobs");
  });

  it("describes an update", () => {
    expect(summarizeOp(data({ kind: "update", table: "jobs", where: { id: 1 }, values: { material: "PLA" } })))
      .toBe("Update rows in printers.jobs");
  });

  it("calls out a delete plainly", () => {
    expect(summarizeOp(data({ kind: "delete", table: "jobs", where: { id: 1 } })))
      .toBe("Delete rows from printers.jobs");
  });

  it("falls back for an op shape it does not recognize", () => {
    expect(summarizeOp(data({ kind: "vacuum" }))).toBe("Write to printers");
  });

  it("describes an infra action by tool name", () => {
    expect(summarizeOp({ origin: "infra", pendingId: "p2", tool: "provision_container", op: {} }))
      .toBe("Run provision_container");
  });

  it("marks a watchdog proposal", () => {
    expect(summarizeOp({ origin: "infra", pendingId: "p3", tool: "grow_disk", op: {}, proposedBy: "watchdog" }))
      .toBe("Run grow_disk (proposed by the watchdog)");
  });
});
