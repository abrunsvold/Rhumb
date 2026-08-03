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
});
