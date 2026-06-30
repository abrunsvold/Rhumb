import { describe, it, expect } from "vitest";
import { writeSseEvent } from "../src/sse.js";

describe("writeSseEvent", () => {
  it("serializes a registry event as a single-line JSON SSE frame", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "registry",
      surfaces: [
        { id: "a", title: "A", url: "/surfaces/a/", kind: "file", created: "t", updated: "t" },
      ],
    });
    const out = chunks.join("");
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    expect(out.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
    const json = JSON.parse(out.slice("data: ".length).trim());
    expect(json.type).toBe("registry");
    expect(json.surfaces[0].url).toBe("/surfaces/a/");
  });
});
