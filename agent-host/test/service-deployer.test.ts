import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("pushes the code to /opt/rhumb/<id> then installs+enables a systemd unit", async () => {
    const { exec, runs, pushes } = fakeExec();
    await createDeployer(exec).deploy(target, "/ws/services/sales", manifest);

    expect(pushes).toEqual([{ localDir: "/ws/services/sales", remoteDir: "/opt/rhumb/sales" }]);
    const script = runs.join("\n");
    expect(script).toContain("/etc/systemd/system/rhumb-sales.service");
    expect(script).toContain("WorkingDirectory=/opt/rhumb/sales");
    expect(script).toContain("Environment=PORT=3000");
    expect(script).toContain("Environment=RHUMB_SERVICE_BASE=/services/sales");
    expect(script).toContain("Restart=always");
    expect(script).toContain("npm ci && npm start");
    expect(script).toContain("systemctl enable --now rhumb-sales.service");
    expect(script).toContain("daemon-reload");
  });

  describe("runtime: node", () => {
    // The Debian/Ubuntu "npm" apt package pulls a long chain of node-* packages
    // (tar, which, string-width, strip-ansi, validate-npm-package-name, ...) —
    // confirmed live to hang/slow a small container. Install bare "nodejs" always;
    // only pull in "npm" + run a remote install when the service isn't already
    // vendored (checked on the LOCAL dir before push, no wasted round trip).
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-deploy-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it("installs nodejs only, skipping npm entirely, when node_modules is already vendored", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      const { exec, runs } = fakeExec();
      await createDeployer(exec).deploy(target, dir, { ...manifest, id: "poller", start: "node index.js", runtime: "node" });
      const script = runs.join("\n");
      expect(script).toContain("apt-get install -y --no-install-recommends nodejs");
      expect(script).not.toMatch(/install[^\n]*\bnpm\b/);
      expect(script).not.toContain("npm ci");
    });

    it("installs nodejs + npm and runs npm ci when package.json exists with no vendored node_modules", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      const { exec, runs } = fakeExec();
      await createDeployer(exec).deploy(target, dir, { ...manifest, id: "poller", runtime: "node" });
      const script = runs.join("\n");
      expect(script).toContain("apt-get install -y --no-install-recommends nodejs");
      expect(script).toMatch(/install[^\n]*\bnpm\b/);
      expect(script).toContain("npm ci --omit=dev");
    });

    it("installs nodejs only when there is no package.json at all", async () => {
      const { exec, runs } = fakeExec();
      await createDeployer(exec).deploy(target, dir, { ...manifest, id: "poller", runtime: "node" });
      const script = runs.join("\n");
      expect(script).toContain("apt-get install -y --no-install-recommends nodejs");
      expect(script).not.toMatch(/install[^\n]*\bnpm\b/);
    });

    it("runs the runtime install before enabling the unit", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      const { exec, runs } = fakeExec();
      await createDeployer(exec).deploy(target, dir, { ...manifest, id: "poller", runtime: "node" });
      const installIdx = runs.findIndex((c) => c.includes("nodejs"));
      const enableIdx = runs.findIndex((c) => c.includes("enable --now"));
      expect(installIdx).toBeGreaterThanOrEqual(0);
      expect(installIdx).toBeLessThan(enableIdx);
    });
  });

  it("installs Python when runtime is python", async () => {
    const { exec, runs } = fakeExec();
    await createDeployer(exec).deploy(target, "/ws/services/p", { ...manifest, id: "p", runtime: "python" });
    const script = runs.join("\n");
    expect(script).toContain("python3");
    expect(script).toContain("python3-pip");
    expect(script).not.toContain("nodejs npm");
  });

  it("installs no runtime when runtime is absent or none", async () => {
    for (const m of [manifest, { ...manifest, runtime: "none" as const }]) {
      const { exec, runs } = fakeExec();
      await createDeployer(exec).deploy(target, "/ws/services/sales", m);
      expect(runs.join("\n")).not.toContain("apt-get install");
    }
  });

  it("adds an Environment line per extraEnv entry", async () => {
    const { exec, runs } = fakeExec();
    await createDeployer(exec).deploy(target, "/ws/services/sales", manifest, {
      DATABASE_URL: "postgres://u:p@h:5432/db",
      RHUMB_DATASOURCE_PRINTERS: "postgres://u:p@h:5432/db",
    });
    const script = runs.join("\n");
    expect(script).toContain("Environment=DATABASE_URL=postgres://u:p@h:5432/db");
    expect(script).toContain("Environment=RHUMB_DATASOURCE_PRINTERS=postgres://u:p@h:5432/db");
  });
});
