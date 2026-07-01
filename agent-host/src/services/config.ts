import { readFileSync } from "node:fs";
import type { ServiceConfig } from "./types.js";

export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig | undefined {
  const deployKeyPath = env.RHUMB_DEPLOY_KEY?.trim();
  const ostemplate = env.RHUMB_LXC_TEMPLATE?.trim();
  const storage = env.RHUMB_LXC_STORAGE?.trim();
  const bridge = env.RHUMB_LXC_BRIDGE?.trim();
  if (!deployKeyPath || !ostemplate || !storage || !bridge) return undefined;

  let deployPublicKey = env.RHUMB_DEPLOY_PUBKEY?.trim() ?? "";
  if (!deployPublicKey) {
    try { deployPublicKey = readFileSync(`${deployKeyPath}.pub`, "utf8").trim(); } catch { deployPublicKey = ""; }
  }
  const workspace = env.RHUMB_WORKSPACE?.trim() || "./workspace";
  return {
    deployKeyPath,
    deployPublicKey,
    ostemplate,
    storage,
    bridge,
    rootfsGb: Number.parseInt(env.RHUMB_LXC_ROOTFS_GB ?? "", 10) || 8,
    servicesPath: env.RHUMB_SERVICES?.trim() || `${workspace}/services.json`,
    workspace,
  };
}
