import { request } from "node:http";
import { connect } from "node:net";
import type { SshExec, SshTarget } from "./types.js";

export interface GateTarget { ssh: SshTarget; unit: string; host: string; port: number; healthPath?: string }
export interface GateState { active: string; nRestarts: number | null; tier: "http" | "tcp"; netOk: boolean; httpStatus?: number }
export type GateResult = { ok: true; probes: number } | { ok: false; reason: string; lastState: GateState | null };
export interface HealthGate { waitHealthy(t: GateTarget): Promise<GateResult> }

// Tiered gate: HTTP 200 when the manifest declares healthPath, else a TCP accept.
// Both tiers also require the systemd unit active with NRestarts unchanged across
// two consecutive probes >= intervalMs apart — "came up" AND "stayed up".
export function createHealthGate(deps: {
  exec: SshExec;
  httpStatus: (url: string) => Promise<number>;
  tcpOk: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  deadlineMs?: number;
  intervalMs?: number;
}): HealthGate {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? 90_000;
  const intervalMs = deps.intervalMs ?? 5_000;

  async function probe(t: GateTarget): Promise<GateState> {
    const tier: "http" | "tcp" = t.healthPath ? "http" : "tcp";
    let active = "unknown";
    let nRestarts: number | null = null;
    try { active = (await deps.exec.run(t.ssh, `systemctl is-active ${t.unit}`)).stdout.trim(); } catch { /* stays unknown */ }
    try {
      const raw = (await deps.exec.run(t.ssh, `systemctl show -p NRestarts --value ${t.unit}`)).stdout.trim();
      const n = Number.parseInt(raw, 10);
      nRestarts = Number.isNaN(n) ? null : n;
    } catch { /* stays null */ }
    let netOk = false;
    let httpStatus: number | undefined;
    if (tier === "http") {
      try { httpStatus = await deps.httpStatus(`http://${t.host}:${t.port}${t.healthPath}`); netOk = httpStatus === 200; } catch { netOk = false; }
    } else {
      try { netOk = await deps.tcpOk(t.host, t.port); } catch { netOk = false; }
    }
    return { active, nRestarts, tier, netOk, ...(httpStatus !== undefined ? { httpStatus } : {}) };
  }

  const good = (s: GateState) => s.active === "active" && s.nRestarts !== null && s.netOk;

  return {
    async waitHealthy(t: GateTarget): Promise<GateResult> {
      const deadline = nowMs() + deadlineMs;
      let prev: GateState | null = null;
      let probes = 0;
      let last: GateState | null = null;
      while (nowMs() < deadline) {
        const cur = await probe(t);
        probes++;
        last = cur;
        if (prev && good(prev) && good(cur) && prev.nRestarts === cur.nRestarts) return { ok: true, probes };
        prev = good(cur) ? cur : null;   // a bad probe resets the streak
        await sleep(intervalMs);
      }
      return { ok: false, reason: `health gate deadline (${deadlineMs}ms) expired without two stable good probes`, lastState: last };
    },
  };
}

// Real probes for production wiring; tests inject fakes.
export function createNetProbes(): { httpStatus: (url: string) => Promise<number>; tcpOk: (host: string, port: number) => Promise<boolean> } {
  return {
    httpStatus: (url) => new Promise((resolve, reject) => {
      const req = request(url, { method: "GET", timeout: 4000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("timeout", () => { req.destroy(new Error("http probe timeout")); });
      req.on("error", reject);
      req.end();
    }),
    tcpOk: (host, port) => new Promise((resolve) => {
      const sock = connect({ host, port, timeout: 4000 });
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
      sock.on("error", () => resolve(false));
    }),
  };
}
