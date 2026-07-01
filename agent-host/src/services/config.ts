import { readFileSync } from "node:fs";
import type { ServiceConfig } from "./types.js";

export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig | undefined {
  const deployKeyPath = env.RHUMBR_DEPLOY_KEY?.trim();
  const ostemplate = env.RHUMBR_LXC_TEMPLATE?.trim();
  const storage = env.RHUMBR_LXC_STORAGE?.trim();
  const bridge = env.RHUMBR_LXC_BRIDGE?.trim();
  if (!deployKeyPath || !ostemplate || !storage || !bridge) return undefined;

  let deployPublicKey = env.RHUMBR_DEPLOY_PUBKEY?.trim() ?? "";
  if (!deployPublicKey) {
    try { deployPublicKey = readFileSync(`${deployKeyPath}.pub`, "utf8").trim(); } catch { deployPublicKey = ""; }
  }
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  return {
    deployKeyPath,
    deployPublicKey,
    ostemplate,
    storage,
    bridge,
    rootfsGb: Number.parseInt(env.RHUMBR_LXC_ROOTFS_GB ?? "", 10) || 8,
    servicesPath: env.RHUMBR_SERVICES?.trim() || `${workspace}/services.json`,
    workspace,
  };
}
