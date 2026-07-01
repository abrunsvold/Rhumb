import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatcher, type WatchFn } from "../src/watcher.js";
import type { RegistrySnapshot } from "../src/types.js";

let root: string;

function writeSurface(id: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({
      id,
      title: id,
      kind: "file",
      entry: "index.html",
      created: "t",
      updated: "t",
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rhumb-watch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startWatcher", () => {
  it("emits an initial snapshot then re-emits on each change", () => {
    writeSurface("d1");
    const snaps: RegistrySnapshot[] = [];
    let trigger: () => void = () => {};
    const watch: WatchFn = (_dir, onChange) => {
      trigger = onChange;
      return { close() {} };
    };

    startWatcher({ root, onSnapshot: (s) => snaps.push(s), watch });

    expect(snaps).toHaveLength(1);
    expect(snaps[0].surfaces.map((s) => s.id)).toEqual(["d1"]);

    writeSurface("d2");
    trigger();

    expect(snaps).toHaveLength(2);
    expect(snaps[1].surfaces.map((s) => s.id).sort()).toEqual(["d1", "d2"]);
  });
});
