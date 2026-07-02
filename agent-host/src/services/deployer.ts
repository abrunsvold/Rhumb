import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SshExec, ServiceDeployer, ServiceManifest, SshTarget } from "./types.js";

export function createDeployer(exec: SshExec): ServiceDeployer {
  return {
    async deploy(target: SshTarget, localDir: string, manifest: ServiceManifest, extraEnv: Record<string, string> = {}): Promise<void> {
      const remoteDir = `/opt/rhumb/${manifest.id}`;
      const unitPath = `/etc/systemd/system/rhumb-${manifest.id}.service`;
      await exec.run(target, `mkdir -p ${remoteDir}`);
      await exec.pushDir(target, localDir, remoteDir);

      // Bare LXC templates ship no runtime; without this a node/python service
      // crash-loops "command not found". Install before the unit is enabled.
      if (manifest.runtime === "node") {
        // The Debian/Ubuntu "npm" apt package drags in a long node-* dependency
        // chain (tar, which, string-width, ...) — confirmed live to be slow/fragile
        // on a small container. Install bare "nodejs" always; only pull "npm" and
        // run a remote install when the pushed dir isn't already vendored (checked
        // locally, before push, so there's no wasted remote round trip).
        await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs");
        const hasPackageJson = existsSync(join(localDir, "package.json"));
        const alreadyVendored = existsSync(join(localDir, "node_modules"));
        if (hasPackageJson && !alreadyVendored) {
          await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends npm");
          await exec.run(target, `cd ${remoteDir} && npm ci --omit=dev || npm install --omit=dev`);
        }
      } else if (manifest.runtime === "python") {
        await exec.run(target, "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-pip python3-venv");
      }

      // Heredoc the unit file. manifest.start runs via bash -lc inside the app dir.
      const unit = [
        "[Unit]",
        `Description=Rhumb service ${manifest.id}`,
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${remoteDir}`,
        `Environment=PORT=${manifest.port}`,
        `Environment=RHUMB_SERVICE_BASE=/services/${manifest.id}`,
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
