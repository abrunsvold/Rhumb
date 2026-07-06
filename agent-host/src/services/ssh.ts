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

const SECRET_LINE = /Environment=|postgres:\/\/|TOKEN|PASSWORD|PRIVATE KEY/i;

// execFile rejections embed the full command line — which for unit-file writes
// includes Environment= lines carrying data-source connection strings. Rebuild
// the error from exit code + a redacted stderr tail; the command never appears.
export function redactSshError(verb: "command" | "copy", e: unknown): Error {
  const err = e as { code?: number | string; stderr?: string };
  const code = err?.code ?? "?";
  // Redact BEFORE slicing: truncating first can cut the marker token off an
  // unbroken >400-char line while the trailing secret value survives. Redacting
  // whole lines first means the cap only ever trims already-redacted text.
  const tail = String(err?.stderr ?? "")
    .split("\n")
    .map((l) => (SECRET_LINE.test(l) ? "[redacted line]" : l))
    .join("\n")
    .slice(-400)
    .trim();
  return new Error(`ssh ${verb} failed (exit ${code})${tail ? `: ${tail}` : ""}`);
}

export function createSshExec(): SshExec {
  return {
    async run(target: SshTarget, command: string) {
      try {
        const { stdout, stderr } = await run("ssh", [...opts(target), `${target.user}@${target.host}`, command], { maxBuffer: 8 * 1024 * 1024 });
        return { stdout, stderr };
      } catch (e) {
        throw redactSshError("command", e);
      }
    },
    async pushDir(target: SshTarget, localDir: string, remoteDir: string) {
      // -r recursive; trailing /. copies contents into remoteDir
      try {
        await run("scp", ["-r", ...opts(target), `${localDir}/.`, `${target.user}@${target.host}:${remoteDir}`], { maxBuffer: 8 * 1024 * 1024 });
      } catch (e) {
        throw redactSshError("copy", e);
      }
    },
  };
}
