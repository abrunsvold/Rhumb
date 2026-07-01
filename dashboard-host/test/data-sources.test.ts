import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDataSources, findSource } from "../src/data/sources.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-ds-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const valid = [
  { id: "ops", type: "postgres", mode: "read-write", connectionString: "postgres://x/db1" },
  { id: "rep", type: "postgres", mode: "read", connectionString: "postgres://x/db2" },
];

describe("loadDataSources", () => {
  it("loads valid sources", () => {
    const p = join(dir, "ds.json");
    writeFileSync(p, JSON.stringify(valid));
    expect(loadDataSources(p)).toEqual(valid);
  });

  it("returns [] when the file is missing", () => {
    expect(loadDataSources(join(dir, "nope.json"))).toEqual([]);
  });

  it("skips invalid entries (bad id, missing fields, wrong mode)", () => {
    const p = join(dir, "mixed.json");
    writeFileSync(p, JSON.stringify([
      valid[0],
      { id: "../bad", type: "postgres", mode: "read", connectionString: "x" },
      { id: "nomode", type: "postgres", connectionString: "x" },
      { id: "badmode", type: "postgres", mode: "write", connectionString: "x" },
    ]));
    expect(loadDataSources(p).map((s) => s.id)).toEqual(["ops"]);
  });

  it("returns [] on malformed JSON", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ not json");
    expect(loadDataSources(p)).toEqual([]);
  });
});

describe("findSource", () => {
  it("finds by id", () => {
    expect(findSource(valid as never, "rep")?.mode).toBe("read");
    expect(findSource(valid as never, "missing")).toBeUndefined();
  });
});
