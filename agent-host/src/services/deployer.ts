import type { SshExec, ServiceDeployer, ServiceManifest, SshTarget } from "./types.js";

export function createDeployer(exec: SshExec): ServiceDeployer {
  return {
    async deploy(target: SshTarget, localDir: string, manifest: ServiceManifest): Promise<void> {
      const remoteDir = `/opt/rhumbr/${manifest.id}`;
      const unitPath = `/etc/systemd/system/rhumbr-${manifest.id}.service`;
      await exec.run(target, `mkdir -p ${remoteDir}`);
      await exec.pushDir(target, localDir, remoteDir);
      // Heredoc the unit file. manifest.start runs via bash -lc inside the app dir.
      const unit = [
        "[Unit]",
        `Description=RHUMBR service ${manifest.id}`,
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${remoteDir}`,
        `Environment=PORT=${manifest.port}`,
        `Environment=RHUMBR_SERVICE_BASE=/services/${manifest.id}`,
        `ExecStart=/bin/bash -lc ${JSON.stringify(manifest.start)}`,
        "Restart=always",
        "RestartSec=2",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");
      await exec.run(target, `cat > ${unitPath} <<'RHUMBR_UNIT_EOF'\n${unit}RHUMBR_UNIT_EOF`);
      await exec.run(target, "systemctl daemon-reload");
      await exec.run(target, `systemctl enable --now rhumbr-${manifest.id}.service`);
    },
  };
}
