import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SshExec, ServiceDeployer, ServiceManifest, SshTarget } from "./types.js";

// Vendored means USABLE: node_modules exists AND every top-level dependency in
// package.json resolves to a directory. An existence-only check shipped a tree
// with pg's transitive deps but no pg (day-2 dogfood F11) — a guaranteed crash loop.
export function isVendoredComplete(localDir: string): boolean {
  const nm = join(localDir, "node_modules");
  if (!existsSync(nm)) return false;
  let deps: Record<string, string>;
  try {
    deps = (JSON.parse(readFileSync(join(localDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch { return false; }
  return Object.keys(deps).every((d) => existsSync(join(nm, ...d.split("/"))));
}

export function createDeployer(exec: SshExec, now: () => string = () => new Date().toISOString()): ServiceDeployer {
  return {
    async deploy(target: SshTarget, localDir: string, manifest: ServiceManifest, extraEnv: Record<string, string> = {}, deployId: string): Promise<void> {
      const remoteDir = `/opt/rhumb/${manifest.id}`;
      const unitPath = `/etc/systemd/system/rhumb-${manifest.id}.service`;
      await exec.run(target, `mkdir -p ${remoteDir}`);
      await exec.pushDir(target, localDir, remoteDir);

      // Bare LXC templates ship no runtime; without this a node/python service
      // crash-loops "command not found". Install before the unit is enabled.
      if (manifest.runtime === "node") {
        // The Debian/Ubuntu "npm" apt package drags in a long node-* dependency
        // chain — confirmed live to be slow/fragile on a small container. Install
        // bare "nodejs" always; only pull "npm" and run a remote install when the
        // pushed dir isn't vendored COMPLETELY (checked locally, before push).
        await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs");
        const hasPackageJson = existsSync(join(localDir, "package.json"));
        if (hasPackageJson && !isVendoredComplete(localDir)) {
          await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends npm");
          await exec.run(target, `cd ${remoteDir} && npm ci --omit=dev || npm install --omit=dev`);
        }
      } else if (manifest.runtime === "python") {
        await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-pip python3-venv");
      }

      // Provenance: ground truth for "which deploy is live in this container".
      const provenance = JSON.stringify({ deployId, deployedAt: now() });
      await exec.run(target, `cat > ${remoteDir}/.rhumb-deploy.json <<'RHUMB_PROV_EOF'\n${provenance}\nRHUMB_PROV_EOF`);

      // Heredoc the unit file. manifest.start runs via bash -lc inside the app dir.
      // StartLimit* live in [Unit]: a crash-looper enters "failed" within ~1 min
      // instead of restarting at 2s forever, so the health gate trips fast.
      const unit = [
        "[Unit]",
        `Description=Rhumb service ${manifest.id}`,
        "After=network-online.target",
        "StartLimitIntervalSec=60",
        "StartLimitBurst=5",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${remoteDir}`,
        `Environment=PORT=${manifest.port}`,
        `Environment=RHUMB_SERVICE_BASE=/services/${manifest.id}`,
        `Environment=RHUMB_DEPLOY_ID=${deployId}`,
        // Injected data-source connection strings (root-only unit file; never logged).
        ...Object.entries(extraEnv).map(([k, v]) => `Environment=${k}=${v}`),
        `ExecStart=/bin/bash -lc ${JSON.stringify(manifest.start)}`,
        "Restart=always",
        "RestartSec=2",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");
      await exec.run(target, `cat > ${unitPath} <<'RHUMB_UNIT_EOF'\n${unit}RHUMB_UNIT_EOF`);
      await exec.run(target, "systemctl daemon-reload");
      await exec.run(target, `systemctl enable --now rhumb-${manifest.id}.service`);
    },
  };
}
