import { describe, it, expect } from "vitest";
import { renderShim, injectShim } from "../src/surfaces/shim.js";

describe("surface shim", () => {
  it("renders a shim carrying the token and surface id", () => {
    const m = renderShim("d1", "TOK123");
    expect(m).toContain("TOK123");
    expect(m).toContain("d1");
    expect(m).toContain("X-Rhumb-Surface-Token");
    expect(m).toContain("<script>");
  });

  it("injects right after <head>", () => {
    const out = injectShim("<html><head><title>x</title></head><body></body></html>", "<!--S-->");
    expect(out).toBe("<html><head><!--S--><title>x</title></head><body></body></html>");
  });

  it("falls back to after <html> when there is no head", () => {
    expect(injectShim("<html><body>hi</body></html>", "<!--S-->"))
      .toBe("<html><!--S--><body>hi</body></html>");
  });

  it("prepends when there is neither head nor html", () => {
    expect(injectShim("<body>hi</body>", "<!--S-->")).toBe("<!--S--><body>hi</body>");
  });
});
