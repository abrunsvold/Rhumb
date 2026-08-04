import { execFile, spawnSync } from "node:child_process";
import type { ExecFn } from "./mngr.js";

/** Real mngr invocation.
 *
 *  `opts.env` is a credential OVERLAY, not a complete environment (see the
 *  contract documented on `ExecFn` in `./mngr.ts`). A replaced environment
 *  would break mngr outright: `mngr` itself shells out to `git`, `tmux`, and
 *  `jq`, and needs `PATH` to find them and `HOME` for its own config. This
 *  merges `opts.env` OVER this process's own environment instead.
 *
 *  This is safe: the credential guarantee this backend provides does not
 *  come from `opts.env` at all. It comes from the explicit `--env` flags
 *  `argvCreate`/`credentialEnvFlags` bake into the argv (mngr.ts), which
 *  override whatever the mngr tmux server was started with regardless of
 *  what this function merges in (docs/dogfood/2026-08-03-mngr-phase0.md,
 *  Q2). `opts.env` merged here is just what the `mngr` CLI process itself
 *  sees — it is not a security boundary.
 *
 *  Uses `execFile` with an argv ARRAY and never `shell: true`: the
 *  backend's injection-safety (see VALID_MNGR_NAME in mngr.ts) depends on
 *  nothing being shell-interpolated. */
export function createRealExec(): ExecFn {
  return (argv, opts) =>
    new Promise((resolve) => {
      execFile(
        "mngr",
        argv,
        { env: { ...process.env, ...opts?.env }, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** Fail fast at boot rather than on the operator's first turn. Precedent:
 *  commit 462acd6 (validate eagerly) and fb30c3d (fail closed).
 *
 *  Checks three things: `mngr` and `tmux` on PATH, and — beyond what the
 *  brief called for — that whatever `bash` resolves to on PATH is major
 *  version 4 or newer. Phase 0 found mngr 0.2.17's
 *  `stream_transcript.sh` uses `declare -A` (bash 4+ associative arrays),
 *  which is not in mngr's documented dependencies (`git`, `tmux`, `jq`).
 *  macOS ships bash 3.2.57 at `/bin/bash`. The failure mode is not a clean
 *  error: the script crash-loops in the agent's tmux pane, Claude never
 *  starts, and `mngr message` fails with a 90-second timeout that looks
 *  exactly like a hang. Catching this at boot turns a silent, misleading
 *  hang into an actionable error naming the real fix.
 *
 *  Both probes are injectable so unit tests never shell out to a real
 *  `mngr`, `tmux`, or `bash`. */
export function assertMngrPrerequisites(
  lookup: (bin: string) => boolean = defaultLookup,
  bashMajorVersion: () => number | null = defaultBashMajorVersion,
): void {
  const problems: string[] = [];

  const missing = ["mngr", "tmux"].filter((b) => !lookup(b));
  if (missing.length > 0) {
    problems.push(
      `requires ${missing.join(" and ")} on PATH. Install with: ` +
        `brew install tmux && uv tool install imbue-mngr && uv tool install imbue-mngr-claude`,
    );
  }

  const version = bashMajorVersion();
  if (version === null || version < 4) {
    const found = version === null ? "an undetectable bash version" : `bash ${version}.x`;
    problems.push(
      `requires bash 4+ on PATH (found ${found}) — mngr's transcript streaming uses bash 4 ` +
        `associative arrays, and macOS ships bash 3.2 at /bin/bash. Fix: brew install bash ` +
        `(installs bash 5 at /opt/homebrew/bin/bash, ahead of /bin on PATH, without touching ` +
        `/bin/bash or your login shell).`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`RHUMB_AGENT_BACKEND=mngr ${problems.join("; also ")}`);
  }
}

function defaultLookup(bin: string): boolean {
  return spawnSync("command", ["-v", bin], { shell: true }).status === 0;
}

/** Probes the MAJOR version of whatever `bash` resolves to on PATH — the
 *  same resolution mngr's `#!/usr/bin/env bash` scripts use. Returns `null`
 *  when the version cannot be determined (bash missing, or unparsable
 *  output), which `assertMngrPrerequisites` treats as a failure, not a
 *  pass — an unknown version is not a verified-good one. */
function defaultBashMajorVersion(): number | null {
  const result = spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(n) ? n : null;
}
