import { isTerminalFinishReason } from "../backends/mngr.js";

export type AgentStatus = "working" | "done" | "failed" | "unknown";

/** The subset of `mngr list --format json` fields Rhumb uses for liveness. */
export interface MngrLiveness {
  state?: string;
  idleSeconds?: number;
}

/** mngr states that mean the agent will never finish. */
const FAILED_STATES: ReadonlySet<string> = new Set(["CRASHED", "FAILED", "DESTROYED"]);

/** Seconds of idleness before an agent with a terminal reply counts as done.
 *  Guards against reading "done" during the gap between the model emitting a
 *  terminal message and starting its next tool call. */
const DEFAULT_IDLE_THRESHOLD_SECONDS = 5;

/** Status from BOTH mngr's own liveness signal and the transcript's terminal
 *  reason. Neither alone suffices: mngr knows the process is idle but not
 *  whether the model finished its thought; the transcript knows the reason but
 *  not whether the agent has since resumed. `null` liveness is "unknown", never
 *  "done" — the same unknowable-vs-absent discipline the backend uses. */
export function deriveAgentStatus(deps: {
  liveness: MngrLiveness | null;
  lastAssistantFinishReason: string | null;
  idleThresholdSeconds?: number;
}): AgentStatus {
  const { liveness, lastAssistantFinishReason } = deps;
  if (liveness === null) return "unknown";
  const state = (liveness.state ?? "").toUpperCase();
  if (FAILED_STATES.has(state)) return "failed";

  const threshold = deps.idleThresholdSeconds ?? DEFAULT_IDLE_THRESHOLD_SECONDS;
  const idle = liveness.idleSeconds ?? 0;
  if (!isTerminalFinishReason(lastAssistantFinishReason)) return "working";
  return idle >= threshold ? "done" : "working";
}
