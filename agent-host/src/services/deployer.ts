import type { SshExec, ServiceDeployer, ServiceManifest, SshTarget } from "./types.js";

export function createDeployer(exec: SshExec): ServiceDeployer {
  return {
    async deploy(target: SshTarget, localDir: string, manifest: ServiceManifest): Promise<void> {
      const remoteDir = `/opt/rhumb/${manifest.id}`;
      const unitPath = `/etc/systemd/system/rhumb-${manifest.id}.service`;
      await exec.run(target, `mkdir -p ${remoteDir}`);
      await exec.pushDir(target, localDir, remoteDir);
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
