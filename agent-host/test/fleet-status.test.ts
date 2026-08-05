import { describe, it, expect } from "vitest";
import { deriveAgentStatus } from "../src/fleet/status.js";

describe("deriveAgentStatus", () => {
  it("is done when a terminal reply exists and the agent has gone idle", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 30 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("done");
  });

  it("is working while the agent is active even with a terminal reply", () => {
    expect(deriveAgentStatus({
      liveness: { state: "RUNNING", idleSeconds: 0 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("working");
  });

  it("is working when the last reply is non-terminal, however idle", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 999 },
      lastAssistantFinishReason: "tool_use",
    })).toBe("working");
  });

  it("is failed when mngr reports a terminal-bad state", () => {
    expect(deriveAgentStatus({
      liveness: { state: "CRASHED", idleSeconds: 0 },
      lastAssistantFinishReason: null,
    })).toBe("failed");
    expect(deriveAgentStatus({
      liveness: { state: "FAILED", idleSeconds: 0 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("failed");
  });

  it("is unknown when liveness cannot be read", () => {
    expect(deriveAgentStatus({ liveness: null, lastAssistantFinishReason: "stop_sequence" })).toBe("unknown");
  });

  it("respects a custom idle threshold", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 3 },
      lastAssistantFinishReason: "stop_sequence",
      idleThresholdSeconds: 10,
    })).toBe("working");
  });
});
