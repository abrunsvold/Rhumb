import { describe, it, expect } from "vitest";
import { hostLabelOf } from "../src/lib/hostLabel";

describe("hostLabelOf", () => {
  it("takes the first label of a tailnet hostname", () => {
    expect(hostLabelOf("https://bmwbox.tail9c2e.ts.net")).toBe("bmwbox");
  });

  it("keeps a bare hostname", () => {
    expect(hostLabelOf("http://localhost:8787")).toBe("localhost");
  });

  it("keeps an IP address whole", () => {
    expect(hostLabelOf("http://192.168.1.24:8787")).toBe("192.168.1.24");
  });

  it("returns an empty string for an unparseable base", () => {
    expect(hostLabelOf("")).toBe("");
  });
});
