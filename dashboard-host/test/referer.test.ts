import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { surfaceIdFromReferer } from "../src/data/router.js";

function req(referer?: string): Request {
  return { get: (h: string) => (h.toLowerCase() === "referer" ? referer : undefined) } as unknown as Request;
}

describe("surfaceIdFromReferer", () => {
  it("extracts the id from a surface URL path", () => {
    expect(surfaceIdFromReferer(req("http://host:8788/surfaces/d1/index.html"))).toBe("d1");
    expect(surfaceIdFromReferer(req("http://host:8788/surfaces/d1/"))).toBe("d1");
  });
  it("returns null when there is no referer or it is not a surface path", () => {
    expect(surfaceIdFromReferer(req(undefined))).toBeNull();
    expect(surfaceIdFromReferer(req("http://host:8788/other"))).toBeNull();
    expect(surfaceIdFromReferer(req("not a url"))).toBeNull();
  });
  it("does NOT extract a surfaces segment hidden in the query string", () => {
    expect(surfaceIdFromReferer(req("http://host:8788/surfaces/real/x?next=/surfaces/evil/"))).toBe("real");
    expect(surfaceIdFromReferer(req("http://host:8788/elsewhere?ref=/surfaces/evil/"))).toBeNull();
  });
});
