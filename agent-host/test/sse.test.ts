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

import { heartbeatFrame, attachHeartbeat } from "../src/sse.js";

describe("heartbeat", () => {
  it("heartbeatFrame is an SSE comment line (ignored by data-only parsers)", () => {
    expect(heartbeatFrame()).toBe(":keepalive\n\n");
  });

  it("attachHeartbeat writes on the interval and stops on request close", () => {
    const writes: string[] = [];
    const res = { write: (s: string) => writes.push(s) };
    let closeCb: (() => void) | undefined;
    const req = { on: (_ev: "close", cb: () => void) => { closeCb = cb; } };
    let tick: (() => void) | undefined;
    const timers = {
      set: ((cb: () => void) => { tick = cb; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval,
      clear: (() => { tick = undefined; }) as typeof clearInterval,
    };
    attachHeartbeat(res, req, 15000, timers);
    tick?.(); tick?.();
    expect(writes).toEqual([":keepalive\n\n", ":keepalive\n\n"]);
    closeCb?.();               // request closed → interval cleared
    expect(tick).toBeUndefined();
  });
});
