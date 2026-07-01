import { describe, it, expect } from "vitest";
import { createDeployer } from "../src/services/deployer.js";
import type { SshExec, SshTarget } from "../src/services/types.js";

function fakeExec() {
  const runs: string[] = [];
  const pushes: Array<{ localDir: string; remoteDir: string }> = [];
  const exec: SshExec = {
    async run(_t: SshTarget, command: string) { runs.push(command); return { stdout: "", stderr: "" }; },
    async pushDir(_t: SshTarget, localDir: string, remoteDir: string) { pushes.push({ localDir, remoteDir }); },
  };
  return { exec, runs, pushes };
}

const target: SshTarget = { host: "10.0.0.5", user: "root", privateKeyPath: "/k" };
const manifest = { id: "sales", type: "service" as const, name: "Sales", start: "npm ci && npm start", port: 3000 };

describe("createDeployer", () => {
  it("pushes the code to /opt/rhumbr/<id> then installs+enables a systemd unit", async () => {
    const { exec, runs, pushes } = fakeExec();
    await createDeployer(exec).deploy(target, "/ws/services/sales", manifest);

    expect(pushes).toEqual([{ localDir: "/ws/services/sales", remoteDir: "/opt/rhumbr/sales" }]);
    const script = runs.join("\n");
    expect(script).toContain("/etc/systemd/system/rhumbr-sales.service");
    expect(script).toContain("WorkingDirectory=/opt/rhumbr/sales");
    expect(script).toContain("Environment=PORT=3000");
    expect(script).toContain("Environment=RHUMBR_SERVICE_BASE=/services/sales");
    expect(script).toContain("Restart=always");
    expect(script).toContain("npm ci && npm start");
    expect(script).toContain("systemctl enable --now rhumbr-sales.service");
    expect(script).toContain("daemon-reload");
  });
});
