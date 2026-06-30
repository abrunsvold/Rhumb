import { describe, it, expect } from "vitest";
import { writeSseEvent } from "../src/sse.js";

describe("writeSseEvent", () => {
  it("serializes an event as a single-line JSON SSE frame", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "session",
      sessionId: "abc",
    });
    expect(chunks.join("")).toBe(
      'data: {"type":"session","sessionId":"abc"}\n\n',
    );
  });

  it("escapes newlines inside payloads so frames stay single-line", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "result",
      result: "line1\nline2",
      isError: false,
    });
    const out = chunks.join("");
    expect(out.endsWith("\n\n")).toBe(true);
    // exactly one data line (the JSON-encoded \n is the two chars backslash-n)
    expect(out.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
  });
});
