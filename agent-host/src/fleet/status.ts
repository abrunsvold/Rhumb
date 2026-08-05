import { isTerminalFinishReason } from "../backends/mngr.js";

export type AgentStatus = "working" | "done" | "blocked" | "stopped" | "failed" | "unknown";

/** The subset of `mngr list --format json` fields Rhumb uses for liveness.
 *  NOTE: mngr's JSON output uses snake_case (`state`, `waiting_reason`).
 *  A later task's adapter must map `waiting_reason → waitingReason` before
 *  calling this function. Failure to map silently produces `undefined`.
 *  See imbue/mngr/primitives.py:262-295 for the real AgentLifecycleState enum. */
export interface MngrLiveness {
  state?: string;
  waitingReason?: string;
}

/** Status from BOTH mngr's own liveness signal and the transcript's terminal
 *  reason. Neither alone suffices: mngr's state tells us if the agent is
 *  running, blocked, or stopped; the transcript's finish_reason tells us if
 *  the model's last message was terminal. When they disagree (e.g., agent
 *  returned from a tool call but hasn't yet emitted a terminal message),
 *  prefer "working" — the safe direction.
 *
 *  `null` liveness means UNKNOWABLE (not "nothing is live"), so return
 *  "unknown" — consistent with the backend's discipline. */
export function deriveAgentStatus(deps: {
  liveness: MngrLiveness | null;
  lastAssistantFinishReason: string | null;
}): AgentStatus {
  const { liveness, lastAssistantFinishReason } = deps;

  // Unknowable is not absent. See test "null liveness means unknown".
  if (liveness === null) return "unknown";

  const state = (liveness.state ?? "").toUpperCase();
  const waitingReason = (liveness.waitingReason ?? "").toUpperCase();

  // AgentLifecycleState enum: UNKNOWN, STOPPED, RUNNING, WAITING, REPLACED,
  // RUNNING_UNKNOWN_AGENT_TYPE, DONE. See imbue/mngr/primitives.py:262-295.
  switch (state) {
    case "UNKNOWN":
      return "unknown";

    case "DONE":
      return "done";

    case "WAITING":
      // WaitingReason enum: PERMISSIONS, END_OF_TURN.
      // See imbue/mngr/primitives.py:281-293.
      if (waitingReason === "PERMISSIONS") {
        // Tool-approval dialog: fleet must not collect answer yet.
        return "blocked";
      }
      if (waitingReason === "END_OF_TURN") {
        // Agent is idle with its turn complete. BUT still check finish_reason:
        // if model is still tool_use-ing, we disagreed with mngr on completion.
        // When they disagree, prefer "working" (safer: wait longer).
        if (isTerminalFinishReason(lastAssistantFinishReason)) {
          return "done";
        }
        return "working";
      }
      // Other/absent waiting reason: fall back to transcript check.
      if (!isTerminalFinishReason(lastAssistantFinishReason)) {
        return "working";
      }
      return "done";

    case "RUNNING":
    case "RUNNING_UNKNOWN_AGENT_TYPE":
      return "working";

    case "STOPPED":
    case "REPLACED":
      return "stopped";

    default:
      // Unrecognized state (missing field, future enum member, or malformed
      // payload) is UNKNOWABLE, not failed. Follow the first rule: null liveness
      // → "unknown". Unrecognized states must also be "unknown", not terminally
      // dead. A fleet must not stop polling a healthy agent due to a payload
      // malformation or an mngr version skew.
      //
      // Note: "failed" is in the union but no branch returns it today.
      // AgentLifecycleState has no failure member; only a future enum member or
      // a new signal source could yield a "failed" status.
      return "unknown";
  }
}
