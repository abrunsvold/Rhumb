import { describe, it, expect } from "vitest";
import { RHUMB_PROMPT_APPEND } from "../src/prompt.js";

describe("RHUMB_PROMPT_APPEND", () => {
  it("explains the operator gate and forbids pre-asking", () => {
    expect(RHUMB_PROMPT_APPEND).toContain("operator approval");
    expect(RHUMB_PROMPT_APPEND).toContain("Call tools directly");
    expect(RHUMB_PROMPT_APPEND).toContain("plain text");
  });

  it("tells the agent the ontology tools exist and how the layers split", () => {
    expect(RHUMB_PROMPT_APPEND).toMatch(/mcp__ontology__query/);
    expect(RHUMB_PROMPT_APPEND).toMatch(/upsert_node/);
    expect(RHUMB_PROMPT_APPEND).toMatch(/system layer/i);
  });

  it("explains that a session is a shared room with attributed turns", () => {
    expect(RHUMB_PROMPT_APPEND).toContain("shared room");
    expect(RHUMB_PROMPT_APPEND).toContain("[from:");
  });

  it("tells the agent how to handle a turn that mentions another person", () => {
    expect(RHUMB_PROMPT_APPEND).toMatch(/mention/i);
    expect(RHUMB_PROMPT_APPEND).toMatch(/addressed/i);
  });
});
