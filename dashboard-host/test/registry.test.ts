import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSurfaceMeta, scanSurfaces, toSnapshot } from "../src/registry.js";

let root: string;

function writeSurface(id: string, meta: unknown, withEntry = true): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "surface.json"), JSON.stringify(meta));
  if (withEntry) writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  return dir;
}

const valid = (id: string) => ({
  id,
  title: `Title ${id}`,
  kind: "file",
  entry: "index.html",
  created: "2026-06-30T00:00:00Z",
  updated: "2026-06-30T00:00:00Z",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rhumbr-surfaces-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readSurfaceMeta", () => {
  it("parses a valid surface.json", () => {
    const dir = writeSurface("dash1", valid("dash1"));
    expect(readSurfaceMeta(dir)).toEqual(valid("dash1"));
  });

  it("returns null when surface.json is missing", () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when id does not match the folder name", () => {
    const dir = writeSurface("dash2", { ...valid("dash2"), id: "other" });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when id has unsafe characters", () => {
    const dir = writeSurface("bad", { ...valid("bad"), id: "../bad" });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when surface.json is malformed", () => {
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "surface.json"), "{ not json");
    expect(readSurfaceMeta(dir)).toBeNull();
  });
});

describe("scanSurfaces", () => {
  it("returns only valid surfaces and skips invalid ones", () => {
    writeSurface("dash1", valid("dash1"));
    writeSurface("dash2", valid("dash2"));
    writeSurface("dash3", { ...valid("dash3"), kind: "service" }); // wrong kind → skipped
    const ids = scanSurfaces(root).map((m) => m.id).sort();
    expect(ids).toEqual(["dash1", "dash2"]);
  });

  it("returns [] when the root does not exist", () => {
    expect(scanSurfaces(join(root, "nope"))).toEqual([]);
  });
});

describe("toSnapshot", () => {
  it("maps metas to client-facing entries with a url and without entry", () => {
    const snap = toSnapshot([valid("dash1")]);
    expect(snap).toEqual({
      surfaces: [
        {
          id: "dash1",
          title: "Title dash1",
          url: "/surfaces/dash1/",
          kind: "file",
          created: "2026-06-30T00:00:00Z",
          updated: "2026-06-30T00:00:00Z",
        },
      ],
    });
    expect("entry" in snap.surfaces[0]).toBe(false);
  });
});
