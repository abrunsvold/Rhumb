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
  it("disallows every mutating built-in and every gated infra tool, none of the read tools", () => {
    const list = watchdogDisallowedTools(GATED_TOOLS);
    for (const t of ["AskUserQuestion", "Bash", "Write", "Edit", "NotebookEdit"]) expect(list).toContain(t);
    for (const g of GATED_TOOLS) expect(list).toContain(`mcp__infra__${g}`);
    expect(list).toContain("mcp__infra__destroy_vm");
    expect(list).not.toContain("mcp__ontology__query");
    expect(list).not.toContain("mcp__infra__service_status");
    expect(list).not.toContain("Read");
  });
});

describe("WATCHDOG_PROMPT", () => {
  it("is report-only and points at the reconcile primitives", () => {
    expect(WATCHDOG_PROMPT).toMatch(/report/i);
    expect(WATCHDOG_PROMPT).toMatch(/mcp__ontology__sync/);
    expect(WATCHDOG_PROMPT).toMatch(/service_status/);
    expect(WATCHDOG_PROMPT).toMatch(/cannot mutate|read-only/i);
  });
});
