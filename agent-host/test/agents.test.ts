import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentRegistry } from "../src/agents.js";

let dir: string;
let indexPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-agents-"));
  indexPath = join(dir, "agents.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeRegistry(ids: string[] = ["id-1", "id-2", "id-3"]) {
  let n = 0;
  return createAgentRegistry({
    indexPath,
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => ids[n++] ?? `id-${n}`,
  });
}

function makeRegistryWithVaryingNow() {
  let n = 0;
  let callCount = 0;
  const times = ["2026-08-03T00:00:00.000Z", "2026-08-03T00:00:01.000Z"];
  return createAgentRegistry({
    indexPath,
    now: () => times[callCount++] ?? "2026-08-03T00:00:02.000Z",
    id: () => ["id-1", "id-2"][n++] ?? `id-${n}`,
  });
}

describe("agent registry", () => {
  it("creates a record with a Rhumb-minted agentId and no nativeId yet", () => {
    const rec = makeRegistry().create("probe", "mngr");
    expect(rec.agentId).toBe("id-1");
    expect(rec.nativeId).toBeNull();
    expect(rec.backend).toBe("mngr");
    expect(rec.name).toBe("probe");
    expect(rec.status).toBe("active");
  });

  it("binds a nativeId to an existing principal", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    reg.bind(rec.agentId, "agent-deadbeef");
    expect(reg.get(rec.agentId)?.nativeId).toBe("agent-deadbeef");
  });

  it("persists across instances", () => {
    const rec = makeRegistry().create("probe", "mngr");
    const reloaded = createAgentRegistry({
      indexPath,
      now: () => "2026-08-03T00:00:00.000Z",
      id: () => "unused",
    });
    expect(reloaded.get(rec.agentId)?.name).toBe("probe");
  });

  it("returns undefined for an unknown agentId", () => {
    expect(makeRegistry().get("nope")).toBeUndefined();
  });

  it("markStopped flips status and list still returns the record", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    reg.markStopped(rec.agentId);
    expect(reg.get(rec.agentId)?.status).toBe("stopped");
    expect(reg.list()).toHaveLength(1);
  });

  it("treats a corrupt index as empty rather than throwing", () => {
    writeFileSync(indexPath, "{ not json");
    expect(makeRegistry().list()).toEqual([]);
  });

  it("bind on unknown agentId returns false and does not create a record", () => {
    const reg = makeRegistry();
    const success = reg.bind("unknown-id", "agent-xyz");
    expect(success).toBe(false);
    expect(reg.list()).toHaveLength(0);
  });

  it("touch on known agentId returns true and updates lastActiveAt", () => {
    const reg = makeRegistryWithVaryingNow();
    const rec = reg.create("probe", "mngr");
    const initialActiveAt = rec.lastActiveAt;
    const success = reg.touch(rec.agentId);
    expect(success).toBe(true);
    const updated = reg.get(rec.agentId);
    expect(updated?.lastActiveAt).not.toBe(initialActiveAt);
  });

  it("touch on unknown agentId returns false", () => {
    const reg = makeRegistry();
    const success = reg.touch("unknown-id");
    expect(success).toBe(false);
  });

  it("markStopped on unknown agentId returns false", () => {
    const reg = makeRegistry();
    const success = reg.markStopped("unknown-id");
    expect(success).toBe(false);
  });

  it("get returns a shallow copy; mutating it does not mutate the registry", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    const retrieved = reg.get(rec.agentId);
    if (retrieved) {
      retrieved.nativeId = "mutated";
      retrieved.status = "stopped";
    }
    const recheck = reg.get(rec.agentId);
    expect(recheck?.nativeId).toBeNull();
    expect(recheck?.status).toBe("active");
  });

  it("list returns shallow copies; mutating them does not mutate the registry", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    const all = reg.list();
    if (all[0]) {
      all[0].nativeId = "mutated";
      all[0].status = "stopped";
    }
    const recheck = reg.get(rec.agentId);
    expect(recheck?.nativeId).toBeNull();
    expect(recheck?.status).toBe("active");
  });
});
