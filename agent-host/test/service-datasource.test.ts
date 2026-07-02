import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataSourceResolver } from "../src/services/datasource.js";

describe("createDataSourceResolver", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-ds-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns the connectionString for a known id, undefined for unknown", () => {
    const p = join(dir, "data-sources.json");
    writeFileSync(p, JSON.stringify([
      { id: "printers", type: "postgres", mode: "read-write", connectionString: "postgres://u:p@h:5432/printers" },
    ]));
    const resolve = createDataSourceResolver(p);
    expect(resolve("printers")).toBe("postgres://u:p@h:5432/printers");
    expect(resolve("ghost")).toBeUndefined();
  });

  it("returns undefined when the file is missing", () => {
    const resolve = createDataSourceResolver(join(dir, "missing.json"));
    expect(resolve("printers")).toBeUndefined();
  });

  it("reflects sources added after the resolver is created (reads fresh)", () => {
    const p = join(dir, "data-sources.json");
    writeFileSync(p, JSON.stringify([]));
    const resolve = createDataSourceResolver(p);
    expect(resolve("printers")).toBeUndefined();
    writeFileSync(p, JSON.stringify([{ id: "printers", type: "postgres", mode: "read-write", connectionString: "postgres://x" }]));
    expect(resolve("printers")).toBe("postgres://x");
  });
});
