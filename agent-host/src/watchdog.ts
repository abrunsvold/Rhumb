// Operate-loop slice 1: a scheduled, structurally read-only reconcile-and-
// report session. See docs/superpowers/specs/2026-07-13-watchdog-design.md.

export const WATCHDOG_PROMPT = [
  "You are Rhumb's read-only watchdog. Reconcile the ontology with live state and report drift.",
  "Steps: call mcp__ontology__sync, then mcp__ontology__query to load the map. The map's system node types are exactly: node, service, container, datasource, dashboard; agent-authored domain nodes are type entity. Query each of those type names literally (first live run queried a nonexistent type, got [], and reported an empty inventory). For every service, check mcp__infra__service_status and, when the map lists a host and port, fetch its health endpoint. Compare service hosts, container ids, and node placement against the map. Note recent DDL activity recorded in datasource node props (lastDdl/ddl7d).",
  "You cannot mutate anything directly — file edits and shell are disabled for this session.",
  "If a problem has a clear one-step remediation among the infra tools (e.g. start_service for a stopped-but-registered service, redeploy_service for a crash-looper), call that tool ONCE: it queues the action for operator approval and returns immediately without executing. Never retry a queued proposal; destroy operations are unavailable to you. Note each queued proposal id in your report.",
  "Lead with anything unhealthy, unreachable, or drifted from the map, followed by any proposals you queued; if everything checks out, say 'All healthy' and give a one-line inventory count. Keep the report terse.",
].join("\n");

// The watchdog may PROPOSE gated remediations (they park for operator
// approval and execute only if approved), but it can never touch files or a
// shell, and it can never even propose destruction — structural, not prompt.
export function watchdogDisallowedTools(): string[] {
  return [
    "AskUserQuestion", "Bash", "Write", "Edit", "NotebookEdit",
    "mcp__infra__destroy_vm", "mcp__infra__destroy_service",
  ];
}

export interface Watchdog {
  start(): void;
  stop(): void;
  tick(): Promise<"ran" | "skipped">;
}

export function createWatchdog(deps: {
  intervalMs: number;
  runTurn: () => Promise<unknown>;
  log?: (message: string) => void;
}): Watchdog {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<"ran" | "skipped"> {
    // Overlap guard: a slow model turn must not stack turns.
    if (running) return "skipped";
    running = true;
    try {
      await deps.runTurn();
    } catch (e) {
      deps.log?.(`[watchdog] turn failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
    return "ran";
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
