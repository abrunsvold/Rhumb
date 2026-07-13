import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWatchdog, watchdogDisallowedTools, WATCHDOG_PROMPT } from "../src/watchdog.js";
import { GATED_TOOLS } from "../src/infra/server.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("createWatchdog", () => {
  it("runs the turn on each interval and stops cleanly", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const w = createWatchdog({ intervalMs: 60_000, runTurn });
    w.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTurn).toHaveBeenCalledTimes(2);
    w.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while the previous turn is still in flight", async () => {
    let release!: () => void;
    const runTurn = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { release = r; }))
      .mockResolvedValue(undefined);
    const w = createWatchdog({ intervalMs: 1000, runTurn });
    const first = w.tick();
    expect(await w.tick()).toBe("skipped");
    expect(runTurn).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe("ran");
    expect(await w.tick()).toBe("ran");
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("logs and swallows a failing turn", async () => {
    const log = vi.fn();
    const w = createWatchdog({ intervalMs: 1000, runTurn: () => Promise.reject(new Error("boom")), log });
    expect(await w.tick()).toBe("ran");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("watchdogDisallowedTools", () => {
  it("disallows mutating built-ins and both destroy tools; proposable gated tools flow to the parked gate", () => {
    const list = watchdogDisallowedTools();
    for (const t of ["AskUserQuestion", "Bash", "Write", "Edit", "NotebookEdit"]) expect(list).toContain(t);
    expect(list).toContain("mcp__infra__destroy_vm");
    expect(list).toContain("mcp__infra__destroy_service");
    // remediation tools are NOT disallowed — they park for approval instead
    expect(list).not.toContain("mcp__infra__start_service");
    expect(list).not.toContain("mcp__infra__redeploy_service");
    expect(list).not.toContain("mcp__ontology__query");
    expect(list).not.toContain("mcp__infra__service_status");
    expect(list).not.toContain("Read");
    expect(GATED_TOOLS.length).toBeGreaterThan(0); // vocabulary still exported for the gate itself
  });
});

describe("WATCHDOG_PROMPT", () => {
  it("is report-only and points at the reconcile primitives", () => {
    expect(WATCHDOG_PROMPT).toMatch(/report/i);
    expect(WATCHDOG_PROMPT).toMatch(/mcp__ontology__sync/);
    expect(WATCHDOG_PROMPT).toMatch(/service_status/);
    expect(WATCHDOG_PROMPT).toMatch(/cannot mutate|read-only/i);
  });

  it("spells out the exact type vocabulary (first live run queried a nonexistent type)", () => {
    expect(WATCHDOG_PROMPT).toMatch(/node, service, container, datasource, dashboard/);
    expect(WATCHDOG_PROMPT).toMatch(/type entity/);
  });

  it("instructs proposal behavior: queue once, never retry, note ids", () => {
    expect(WATCHDOG_PROMPT).toMatch(/operator approval/);
    expect(WATCHDOG_PROMPT).toMatch(/Never retry/);
    expect(WATCHDOG_PROMPT).toMatch(/proposal id/);
    expect(WATCHDOG_PROMPT).toMatch(/destroy operations are unavailable/i);
  });
});
