import { describe, it, expect } from "vitest";
import { buildRoster } from "../src/roster.js";

describe("buildRoster", () => {
  it("uses the local part of a login as its handle", () => {
    expect(buildRoster(["op@example.com"])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("normalizes case and whitespace, and drops blanks", () => {
    expect(buildRoster(["  Op@Example.com ", "", "   "])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("dedupes repeated logins", () => {
    expect(buildRoster(["op@example.com", "op@example.com"])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("falls back to the full login when two local parts collide", () => {
    expect(buildRoster(["op@a.com", "op@b.com", "zoe@a.com"])).toEqual([
      { login: "op@a.com", handle: "op@a.com" },
      { login: "op@b.com", handle: "op@b.com" },
      { login: "zoe@a.com", handle: "zoe" },
    ]);
  });

  it("passes through a login with no at-sign", () => {
    expect(buildRoster(["operator"])).toEqual([{ login: "operator", handle: "operator" }]);
  });
});
