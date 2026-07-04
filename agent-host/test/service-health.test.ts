import { describe, it, expect } from "vitest";
import { createHealthGate } from "../src/services/health.js";
import type { SshExec } from "../src/services/types.js";

// Scripted fake: each probe round consumes one entry {active, n, http?, tcp?}.
function harness(rounds: Array<{ active: string; n: number | null; http?: number; tcp?: boolean }>) {
  let i = -1;
  let clock = 0;
  const exec: SshExec = {
    async run(_t, cmd) {
      if (cmd.startsWith("systemctl is-active")) { i++; return { stdout: `${rounds[Math.min(i, rounds.length - 1)].active}\n`, stderr: "" }; }
      if (cmd.includes("NRestarts")) { const n = rounds[Math.min(i, rounds.length - 1)].n; if (n === null) throw new Error("boom"); return { stdout: `${n}\n`, stderr: "" }; }
      throw new Error(`unexpected cmd ${cmd}`);
    },
    async pushDir() { throw new Error("unused"); },
  };
  const gate = createHealthGate({
    exec,
    httpStatus: async () => { const r = rounds[Math.min(i, rounds.length - 1)]; if (r.http === undefined) throw new Error("conn refused"); return r.http; },
    tcpOk: async () => rounds[Math.min(i, rounds.length - 1)].tcp ?? false,
    sleep: async (ms) => { clock += ms; },
    nowMs: () => clock,
    deadlineMs: 60_000,
    intervalMs: 5_000,
  });
  return gate;
}
const t = (healthPath?: string) => ({ ssh: { host: "h", user: "root", privateKeyPath: "/k" }, unit: "rhumb-x.service", host: "10.0.0.9", port: 8080, healthPath });

describe("health gate", () => {
  it("passes on two consecutive good HTTP probes with stable NRestarts", async () => {
    const r = await harness([{ active: "active", n: 0, http: 200 }, { active: "active", n: 0, http: 200 }]).waitHealthy(t("/health"));
    expect(r).toEqual({ ok: true, probes: 2 });
  });

  it("passes on the TCP tier when no healthPath is declared", async () => {
    const r = await harness([{ active: "active", n: 0, tcp: true }, { active: "active", n: 0, tcp: true }]).waitHealthy(t());
    expect(r.ok).toBe(true);
  });

  it("fails at deadline while the unit crash-loops (is-active never active)", async () => {
    const rounds = Array.from({ length: 20 }, () => ({ active: "activating", n: 7, tcp: true }));
    const r = await harness(rounds).waitHealthy(t());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toContain("deadline"); expect(r.lastState?.active).toBe("activating"); }
  });

  it("flapping NRestarts never yields two stable consecutive probes", async () => {
    const rounds = Array.from({ length: 20 }, (_, k) => ({ active: "active", n: k, http: 200 }));
    const r = await harness(rounds).waitHealthy(t("/health"));
    expect(r.ok).toBe(false);
  });

  it("HTTP non-200 and HTTP connection error both fail the probe", async () => {
    const rounds = Array.from({ length: 20 }, (_, k) => ({ active: "active", n: 0, http: k % 2 ? 500 : undefined }));
    const r = await harness(rounds).waitHealthy(t("/health"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastState?.tier).toBe("http");
  });

  it("ssh probe errors count as bad probes, not crashes", async () => {
    const rounds = Array.from({ length: 20 }, () => ({ active: "active", n: null as null, tcp: true }));
    const r = await harness(rounds).waitHealthy(t());
    expect(r.ok).toBe(false);
  });
});
