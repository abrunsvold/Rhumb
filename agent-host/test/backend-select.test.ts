import { describe, it, expect } from "vitest";
import { assertMngrPrerequisites, parseBashMajor } from "../src/backends/exec.js";

describe("assertMngrPrerequisites", () => {
  it("passes when all binaries are present and bash is 4+", () => {
    expect(() => assertMngrPrerequisites(() => true, () => 5)).not.toThrow();
  });

  it("names the missing binary and stays actionable", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "tmux", () => 5)).toThrow(/tmux/);
  });

  it("reports mngr when mngr is the missing one", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "mngr", () => 5)).toThrow(/mngr/);
  });

  it("reports git when git is missing (I3)", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "git", () => 5)).toThrow(/git/);
  });

  it("reports jq when jq is missing (I3)", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "jq", () => 5)).toThrow(/jq/);
  });

  it("names an install command that actually works (I4): --with, not a separate install", () => {
    let message = "";
    try {
      assertMngrPrerequisites(() => false, () => 5);
    } catch (e) {
      message = (e as Error).message;
    }
    // The verified-working command: imbue-mngr-claude installed via --with,
    // not as a separate `uv tool install`.
    expect(message).toContain("uv tool install imbue-mngr --with imbue-mngr-claude");
    expect(message).toContain("brew install");
    expect(message).toContain("apt-get install");
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

describe("parseBashMajor (I5)", () => {
  it("returns null on non-zero status regardless of stdout", () => {
    expect(parseBashMajor(1, "5")).toBeNull();
  });

  it("returns null on empty stdout", () => {
    expect(parseBashMajor(0, "")).toBeNull();
  });

  it("returns null on stdout that trims to empty", () => {
    expect(parseBashMajor(0, "\n")).toBeNull();
  });

  it("returns null on unparsable stdout", () => {
    expect(parseBashMajor(0, "not a number")).toBeNull();
  });

  it("parses a single-digit major version", () => {
    expect(parseBashMajor(0, "3")).toBe(3);
  });

  it("parses a newline-trailing major version", () => {
    expect(parseBashMajor(0, "5\n")).toBe(5);
  });
});
