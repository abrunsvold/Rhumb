import { describe, it, expect } from "vitest";
import { connStringForDb } from "../src/infra/pgAdmin.js";

describe("connStringForDb", () => {
  it("swaps the database name, preserving host/port/credentials", () => {
    const out = connStringForDb("postgres://admin:secret@10.0.0.5:5432/postgres", "reports");
    expect(out).toBe("postgres://admin:secret@10.0.0.5:5432/reports");
  });

  it("swaps the database when the admin string points at a non-default db", () => {
    const out = connStringForDb("postgres://u:p@localhost:5432/template1", "sales");
    expect(out).toBe("postgres://u:p@localhost:5432/sales");
  });
});
