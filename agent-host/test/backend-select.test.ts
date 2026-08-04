import { describe, it, expect } from "vitest";
import { assertMngrPrerequisites } from "../src/backends/exec.js";

describe("assertMngrPrerequisites", () => {
  it("passes when both binaries are present and bash is 4+", () => {
    expect(() => assertMngrPrerequisites(() => true, () => 5)).not.toThrow();
  });

  it("names the missing binary and stays actionable", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "tmux", () => 5)).toThrow(/tmux/);
  });

  it("reports mngr when mngr is the missing one", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "mngr", () => 5)).toThrow(/mngr/);
  });

  it("rejects bash 3, naming the real fix", () => {
    expect(() => assertMngrPrerequisites(() => true, () => 3)).toThrow(/bash/i);
    expect(() => assertMngrPrerequisites(() => true, () => 3)).toThrow(/brew install bash/);
  });

  it("rejects an undetectable bash version rather than assuming it's fine", () => {
    expect(() => assertMngrPrerequisites(() => true, () => null)).toThrow(/bash/i);
  });

  it("accepts bash 4 exactly (boundary)", () => {
    expect(() => assertMngrPrerequisites(() => true, () => 4)).not.toThrow();
  });

  it("reports both a missing binary and an old bash together", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "tmux", () => 3)).toThrow(/tmux/);
    expect(() => assertMngrPrerequisites((b) => b !== "tmux", () => 3)).toThrow(/bash/i);
  });
});
