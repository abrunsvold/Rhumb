import { loadProvider, type ProviderConfig } from "./provider.js";
import type { BackendId } from "./backends/types.js";
import { loadFleetCaps, type FleetCaps } from "./fleet/caps.js";

export interface Config {
  port: number;
  workspace: string;
  provider: ProviderConfig;
  permissionMode: string;
  controlToken?: string;
  allowedUsers: string[];
  insecureDev: boolean;
  watchdogMinutes: number | null;
  agentBackend: BackendId;
  /** Master switch for model-directed agent spawning. Default OFF — see
   *  `loadFleetEnabled`. */
  fleetEnabled: boolean;
  fleetCaps: FleetCaps;
}

/** `RHUMB_FLEET_ENABLED` — the fleet's kill switch, and the ONLY thing that
 *  turns model-directed agent spawning on.
 *
 *  Default OFF, deliberately. The fleet spawns through mngr regardless of
 *  `RHUMB_AGENT_BACKEND`, so without an explicit switch every box that
 *  happens to have `mngr` on PATH would SILENTLY gain model-directed
 *  spawning on upgrade — a capability the operator never asked for and might
 *  not know about. Caps cannot express "off" either (`loadFleetCaps` rejects
 *  0), so this is the only place that can.
 *
 *  Fails closed on anything unrecognised rather than throwing: an
 *  unparseable value must never be read as "on", and a host that is already
 *  running must not be prevented from booting by a typo in an OPTIONAL
 *  feature flag (unlike a malformed cap, which is only ever set by an
 *  operator who has already opted in, and where failing loud is right). The
 *  typo is warned about by name so it is not silent. */
export function loadFleetEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RHUMB_FLEET_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  console.warn(
    `[rhumb] WARNING: RHUMB_FLEET_ENABLED="${env.RHUMB_FLEET_ENABLED}" is not a recognised ` +
      "boolean (use 1/0, true/false, yes/no, on/off). Treating it as OFF: the fleet tools " +
      "will NOT be available this boot.",
  );
  return false;
}

const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const provider = loadProvider(env);
  let port = 8787;
  if (env.RHUMB_PORT) {
    const parsed = Number.parseInt(env.RHUMB_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMB_PORT must be a number, got "${env.RHUMB_PORT}"`,
      );
    }
    port = parsed;
  }

  let permissionMode = "acceptEdits";
  if (env.RHUMB_PERMISSION_MODE) {
    const value = env.RHUMB_PERMISSION_MODE.trim();
    if (!VALID_PERMISSION_MODES.has(value)) {
      throw new Error(
        `RHUMB_PERMISSION_MODE must be one of default|acceptEdits|bypassPermissions|plan, got "${value}"`,
      );
    }
    permissionMode = value;
  }

  const insecureDev = env.RHUMB_INSECURE_DEV === "1";
  const allowedUsers = (env.RHUMB_ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (!insecureDev && allowedUsers.length === 0) {
    throw new Error(
      "RHUMB_ALLOWED_USERS is required (comma-separated tailnet logins, e.g. " +
        "you@example.com). Rhumb fails closed: every request must carry an " +
        "allowlisted Tailscale identity. Set RHUMB_INSECURE_DEV=1 only for " +
        "local development without tailscale serve.",
    );
  }

  const rawBackend = env.RHUMB_AGENT_BACKEND?.trim();
  if (rawBackend && rawBackend !== "sdk" && rawBackend !== "mngr") {
    throw new Error(
      `RHUMB_AGENT_BACKEND must be one of sdk|mngr, got "${rawBackend}".`,
    );
  }
  const agentBackend: BackendId = rawBackend === "mngr" ? "mngr" : "sdk";

  return {
    port,
    workspace: env.RHUMB_WORKSPACE?.trim() || "./workspace",
    provider,
    permissionMode,
    controlToken: env.RHUMB_CONTROL_TOKEN?.trim() || undefined,
    allowedUsers,
    insecureDev,
    watchdogMinutes: (() => {
      const n = Number.parseInt(env.RHUMB_WATCHDOG_MINUTES ?? "", 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    })(),
    agentBackend,
    fleetEnabled: loadFleetEnabled(env),
    fleetCaps: loadFleetCaps(env),
  };
}
