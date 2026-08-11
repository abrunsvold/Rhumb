import { describe, it, expect } from "vitest";
import { stampAuthor, parseEnvelope } from "../src/envelope.js";

describe("stampAuthor", () => {
  it("prefixes a from-line above the body", () => {
    expect(stampAuthor("op@example.com", "hi")).toBe("[from: op@example.com]\nhi");
  });
});

describe("parseEnvelope", () => {
  it("round-trips a stamped message", () => {
    const stamped = stampAuthor("op@example.com", "what is up");
    expect(parseEnvelope(stamped)).toEqual({ author: "op@example.com", text: "what is up" });
  });

  it("preserves a multi-line body", () => {
    const stamped = stampAuthor("op@example.com", "line one\nline two");
    expect(parseEnvelope(stamped)).toEqual({ author: "op@example.com", text: "line one\nline two" });
  });

  it("round-trips an empty body", () => {
    expect(parseEnvelope(stampAuthor("op@example.com", ""))).toEqual({
      author: "op@example.com",
      text: "",
    });
  });

  it("returns unenvelope text unchanged with a null author", () => {
    expect(parseEnvelope("just a prompt")).toEqual({ author: null, text: "just a prompt" });
  });

  it("does not match a from-line with no body separator", () => {
    expect(parseEnvelope("[from: op@example.com]")).toEqual({
      author: null,
      text: "[from: op@example.com]",
    });
  });

  it("does not match a from-line that is not first", () => {
    expect(parseEnvelope("hello\n[from: op@example.com]\nbye")).toEqual({
      author: null,
      text: "hello\n[from: op@example.com]\nbye",
    });
  });
});
