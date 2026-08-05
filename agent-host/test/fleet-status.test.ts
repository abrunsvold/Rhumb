import { describe, it, expect } from "vitest";
import { deriveAgentStatus } from "../src/fleet/status.js";

// Tests based on imbue/mngr/primitives.py:262-295 AgentLifecycleState enum:
// UNKNOWN, STOPPED, RUNNING, WAITING, REPLACED, RUNNING_UNKNOWN_AGENT_TYPE, DONE.
// WaitingReason: PERMISSIONS, END_OF_TURN (see imbue/mngr/primitives.py:281-293).

describe("deriveAgentStatus", () => {
  describe("unknown state", () => {
    it("returns unknown when liveness is null", () => {
      expect(deriveAgentStatus({ liveness: null, lastAssistantFinishReason: "stop_sequence" })).toBe("unknown");
    });

    it("returns unknown when state is UNKNOWN", () => {
      expect(deriveAgentStatus({
        liveness: { state: "UNKNOWN", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("unknown");
    });

    it("normalizes lowercase state to uppercase", () => {
      expect(deriveAgentStatus({
        liveness: { state: "unknown", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("unknown");
    });

    it("returns unknown when state is unrecognized", () => {
      // Future enum member or unrecognized state: unknowable, not failed.
      // A fleet must not stop polling a healthy agent due to version skew.
      expect(deriveAgentStatus({
        liveness: { state: "SOMETHING_ELSE", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("unknown");
    });

    it("returns unknown when state field is missing (malformed payload)", () => {
      // Payload malformation is unknowable, not failed. This covers the case
      // where toUpperCase() on undefined state becomes "".
      expect(deriveAgentStatus({
        liveness: {},
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("unknown");
    });
  });

  describe("done state", () => {
    it("returns done for DONE state regardless of finish_reason", () => {
      expect(deriveAgentStatus({
        liveness: { state: "DONE", waitingReason: undefined },
        lastAssistantFinishReason: null,
      })).toBe("done");
    });
  });

  describe("working state", () => {
    it("returns working when state is RUNNING", () => {
      expect(deriveAgentStatus({
        liveness: { state: "RUNNING", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("working");
    });

    it("returns working when state is RUNNING_UNKNOWN_AGENT_TYPE", () => {
      expect(deriveAgentStatus({
        liveness: { state: "RUNNING_UNKNOWN_AGENT_TYPE", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("working");
    });

    it("returns working when WAITING+END_OF_TURN disagrees with non-terminal finish_reason", () => {
      // Agent returned from tool call but hasn't yet emitted terminal message.
      // mngr says WAITING+END_OF_TURN (ready for more work), transcript says tool_use.
      // When they disagree, prefer "working" (safer: wait longer).
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "END_OF_TURN" },
        lastAssistantFinishReason: "tool_use",
      })).toBe("working");
    });

    it("returns working when WAITING with no waiting_reason and finish_reason is non-terminal", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: undefined },
        lastAssistantFinishReason: "tool_use",
      })).toBe("working");
    });
  });

  describe("done via END_OF_TURN", () => {
    it("returns done for WAITING+END_OF_TURN with terminal finish_reason", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "END_OF_TURN" },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("done");
    });

    it("returns done for WAITING+END_OF_TURN with end_turn", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "END_OF_TURN" },
        lastAssistantFinishReason: "end_turn",
      })).toBe("done");
    });

    it("returns done for WAITING+END_OF_TURN with max_tokens", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "END_OF_TURN" },
        lastAssistantFinishReason: "max_tokens",
      })).toBe("done");
    });
  });

  describe("blocked state", () => {
    it("returns blocked for WAITING+PERMISSIONS", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "PERMISSIONS" },
        lastAssistantFinishReason: null,
      })).toBe("blocked");
    });

    it("returns blocked for WAITING+PERMISSIONS even with terminal finish_reason", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "PERMISSIONS" },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("blocked");
    });
  });

  describe("stopped state", () => {
    it("returns stopped for STOPPED state", () => {
      expect(deriveAgentStatus({
        liveness: { state: "STOPPED", waitingReason: undefined },
        lastAssistantFinishReason: null,
      })).toBe("stopped");
    });

    it("returns stopped for REPLACED state", () => {
      expect(deriveAgentStatus({
        liveness: { state: "REPLACED", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("stopped");
    });
  });

  describe("fallback logic and edge cases", () => {
    it("falls back to terminal finish_reason for WAITING without waiting_reason", () => {
      // Without waiting_reason, should check terminal finish_reason.
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: undefined },
        lastAssistantFinishReason: "stop_sequence",
      })).toBe("done");
    });

    it("normalizes waiting_reason to uppercase", () => {
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: "permissions" },
        lastAssistantFinishReason: null,
      })).toBe("blocked");
    });

    it("note: unknown finish_reason is non-terminal (falls back to working)", () => {
      // An unrecognized finish_reason (e.g., future API value) is not terminal,
      // so WAITING without waiting_reason reads as working.
      expect(deriveAgentStatus({
        liveness: { state: "WAITING", waitingReason: undefined },
        lastAssistantFinishReason: "some_future_reason",
      })).toBe("working");
    });
  });
});
