import { describe, it, expect } from "vitest";
import { surfaceHeaders } from "../src/surfaces/headers.js";

describe("surfaceHeaders", () => {
  it("sets nosniff and a CSP with connect-src 'self' and app-only frame-ancestors", () => {
    const h = surfaceHeaders(["tauri://localhost", "https://tauri.localhost"]);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors tauri://localhost https://tauri.localhost");
    expect(csp).not.toContain("frame-ancestors 'self'");
  });
});
