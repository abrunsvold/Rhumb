import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshExec, SshTarget } from "./types.js";

const run = promisify(execFile);
const opts = (t: SshTarget) => [
  "-i", t.privateKeyPath,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
];

export function createSshExec(): SshExec {
  return {
    async run(target: SshTarget, command: string) {
      const { stdout, stderr } = await run("ssh", [...opts(target), `${target.user}@${target.host}`, command], { maxBuffer: 8 * 1024 * 1024 });
      return { stdout, stderr };
    },
    async pushDir(target: SshTarget, localDir: string, remoteDir: string) {
      // -r recursive; trailing /. copies contents into remoteDir
      await run("scp", ["-r", ...opts(target), `${localDir}/.`, `${target.user}@${target.host}:${remoteDir}`], { maxBuffer: 8 * 1024 * 1024 });
    },
  };
}
