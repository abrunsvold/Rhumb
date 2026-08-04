import { execFile, spawnSync } from "node:child_process";
import type { ExecFn } from "./mngr.js";

/** Phase 0 documented a 90s wedge class: `mngr message` can hang waiting for
 *  a submission signal it never receives (docs/dogfood/2026-08-03-mngr-phase0.md,
 *  Q1). Without a timeout that hangs the turn — and the SSE stream the
 *  operator is watching — forever. 120s gives the documented 90s case
 *  headroom while still guaranteeing every mngr call eventually resolves. */
const EXEC_TIMEOUT_MS = 120_000;

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
 *  Q2). As of fix round 1 (I1), mngr.ts no longer passes `credentialEnv`
 *  via `opts.env` at any call site — see the doc comment on `ExecFn` for
 *  why that mattered (the tmux daemon persisting a raw credential for its
 *  whole lifetime). `opts.env`, when a future caller does pass it, is just
 *  what the `mngr` CLI process itself sees — it is not a security boundary.
 *
 *  Uses `execFile` with an argv ARRAY and never `shell: true`: the
 *  backend's injection-safety (see VALID_MNGR_NAME in mngr.ts) depends on
 *  nothing being shell-interpolated.
 *
 *  Carries a timeout (M1) — see EXEC_TIMEOUT_MS — so a wedged `mngr`
 *  invocation cannot hang a turn forever. A `maxBuffer` overflow is
 *  reported distinctly from a timeout in the returned `stderr` (fix
 *  round 3, Minor 3) even though Node signals both by killing the child
 *  and setting `err.killed`. */
export function createRealExec(): ExecFn {
  return (argv, opts) =>
    new Promise((resolve) => {
      execFile(
        "mngr",
        argv,
        {
          env: { ...process.env, ...opts?.env },
          maxBuffer: 32 * 1024 * 1024,
          timeout: EXEC_TIMEOUT_MS,
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          // `err.killed` is true for BOTH causes execFile can kill the
          // child for — the `timeout` option elapsing, and `maxBuffer`
          // being exceeded (Node sets `err.code ===
          // "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` for the latter; a real
          // timeout does not use that code). Fix round 3, Minor 3:
          // reporting a >32MB transcript/output as "timed out after
          // 120000ms" would be actively misleading in logs/audit — the
          // process didn't hang, its output was too large — so these are
          // distinguished rather than collapsed into one message.
          const killedByMaxBuffer =
            Boolean(err) && (err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const timedOut = Boolean(err && (err as { killed?: boolean }).killed) && !killedByMaxBuffer;
          const stderrText =
            String(stderr) +
            (timedOut ? `\n[rhumb] mngr call timed out after ${EXEC_TIMEOUT_MS}ms and was killed` : "") +
            (killedByMaxBuffer ? "\n[rhumb] mngr call exceeded the 32MB output buffer and was killed" : "");
          resolve({ code, stdout: String(stdout), stderr: stderrText });
        },
      );
    });
}

/** Fail fast at boot rather than on the operator's first turn. Precedent:
 *  commit 462acd6 (validate eagerly) and fb30c3d (fail closed).
 *
 *  Checks mngr's own documented dependencies — `git`, `tmux`, `jq` (I3; the
 *  deploy target is a Debian LXC where `jq` in particular is often absent)
 *  — plus one undocumented one Phase 0 found the hard way: whatever `bash`
 *  resolves to on PATH must be major version 4 or newer. mngr 0.2.17's
 *  `stream_transcript.sh` uses `declare -A` (bash 4+ associative arrays),
 *  and macOS ships bash 3.2.57 at `/bin/bash`. The failure mode is not a
 *  clean error: the script crash-loops in the agent's tmux pane, Claude
 *  never starts, and `mngr message` fails with a 90-second timeout that
 *  looks exactly like a hang. Catching this at boot turns a silent,
 *  misleading hang into an actionable error naming the real fix.
 *
 *  Both probes are injectable so unit tests never shell out to a real
 *  `mngr`/`tmux`/`git`/`jq`/`bash`. */
export function assertMngrPrerequisites(
  lookup: (bin: string) => boolean = defaultLookup,
  bashMajorVersion: () => number | null = defaultBashMajorVersion,
): void {
  const problems: string[] = [];

  const missing = ["mngr", "tmux", "git", "jq"].filter((b) => !lookup(b));
  if (missing.length > 0) {
    problems.push(
      `requires ${missing.join(", ")} on PATH. Install (I4: the previous hint here named a ` +
        `command that does NOT work — \`uv tool install imbue-mngr-claude\` on its own creates ` +
        `a SEPARATE tool env and does not add the \`claude\` agent type to \`imbue-mngr\`; it ` +
        `must be installed via --with, as below). macOS: ` +
        "`brew install tmux git jq && uv tool install imbue-mngr --with imbue-mngr-claude`. " +
        "Debian/Ubuntu: `apt-get install -y tmux git jq && uv tool install imbue-mngr --with " +
        "imbue-mngr-claude`.",
    );
  }

  const version = bashMajorVersion();
  if (version === null || version < 4) {
    const found = version === null ? "an undetectable bash version" : `bash ${version}.x`;
    problems.push(
      `requires bash 4+ on PATH (found ${found}) — mngr's transcript streaming uses bash 4 ` +
        `associative arrays, and macOS ships bash 3.2 at /bin/bash. Fix: brew install bash ` +
        `(installs bash 5 at /opt/homebrew/bin/bash, ahead of /bin on PATH, without touching ` +
        `/bin/bash or your login shell); Debian/Ubuntu ships bash 5 already, so this should only ` +
        `fire there if PATH has been overridden.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`RHUMB_AGENT_BACKEND=mngr ${problems.join("; also ")}`);
  }
}

function defaultLookup(bin: string): boolean {
  return spawnSync("command", ["-v", bin], { shell: true }).status === 0;
}

/** Pure parse of the bash-version probe's raw result (I5) — the only part
 *  of `defaultBashMajorVersion` that can actually be wrong, and therefore
 *  the only part worth unit-testing directly. The `spawnSync` call itself
 *  is exactly what injecting `bashMajorVersion` in
 *  `assertMngrPrerequisites` exists to avoid exercising in a unit test. */
export function parseBashMajor(status: number | null, stdout: string): number | null {
  if (status !== 0 || !stdout) return null;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isInteger(n) ? n : null;
}

/** Probes the MAJOR version of whatever `bash` resolves to on PATH — the
 *  same resolution mngr's `#!/usr/bin/env bash` scripts use. Returns `null`
 *  when the version cannot be determined (bash missing, or unparsable
 *  output), which `assertMngrPrerequisites` treats as a failure, not a
 *  pass — an unknown version is not a verified-good one. */
function defaultBashMajorVersion(): number | null {
  const result = spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
  return parseBashMajor(result.status, result.stdout ?? "");
}
