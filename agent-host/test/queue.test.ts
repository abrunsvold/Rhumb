import { describe, it, expect } from "vitest";
import { createTurnQueue } from "../src/queue.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("createTurnQueue", () => {
  it("runs one turn at a time per lane, in arrival order", async () => {
    const started: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const q = createTurnQueue({ onDepth: () => {} });

    for (let i = 0; i < 3; i++) {
      q.enqueue("s1", async () => {
        started.push(i);
        await gates[i].promise;
      });
    }
    await flush();
    expect(started).toEqual([0]);

    // Resolve out of order: the lane must still advance strictly in order.
    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1]);

    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[2].resolve();
    await flush();
    expect(q.depth("s1")).toBe(0);
  });

  it("advances the lane when a turn throws", async () => {
    const started: string[] = [];
    const q = createTurnQueue({ onDepth: () => {} });

    q.enqueue("s1", async () => {
      started.push("boom");
      throw new Error("turn failed");
    });
    q.enqueue("s1", async () => {
      started.push("after");
    });

    await flush();
    expect(started).toEqual(["boom", "after"]);
    expect(q.depth("s1")).toBe(0);
  });

  it("drains different lanes concurrently", async () => {
    const started: string[] = [];
    const a = deferred();
    const b = deferred();
    const q = createTurnQueue({ onDepth: () => {} });

    q.enqueue("s1", async () => {
      started.push("s1");
      await a.promise;
    });
    q.enqueue("s2", async () => {
      started.push("s2");
      await b.promise;
    });

    await flush();
    expect(started).toEqual(["s1", "s2"]);
    a.resolve();
    b.resolve();
    await flush();
  });

  it("rekeys a pending lane without running two turns at once", async () => {
    const started: string[] = [];
    const first = deferred();
    const q = createTurnQueue({ onDepth: () => {} });

    // A brand-new room: both turns arrive before the session id exists.
    q.enqueue("", async () => {
      started.push("first");
      await first.promise;
    });
    q.enqueue("", async () => {
      started.push("second");
    });
    await flush();
    expect(started).toEqual(["first"]);

    // The session event arrives mid-turn.
    q.rekey("", "s1");
    await flush();
    expect(started).toEqual(["first"]); // still one at a time

    first.resolve();
    await flush();
    expect(started).toEqual(["first", "second"]);
    expect(q.depth("s1")).toBe(0);
    expect(q.depth("")).toBe(0);
  });

  it("reports depth under the new key after a rekey", async () => {
    const seen: Array<[string, number]> = [];
    const gate = deferred();
    const q = createTurnQueue({ onDepth: (k, d) => seen.push([k, d]) });

    q.enqueue("", async () => {
      await gate.promise;
    });
    q.rekey("", "s1");
    q.enqueue("s1", async () => {});
    gate.resolve();
    await flush();

    expect(seen[0]).toEqual(["", 1]);
    expect(seen.some(([k]) => k === "s1")).toBe(true);
    expect(seen[seen.length - 1]).toEqual(["s1", 0]);
  });

  it("emits depth zero exactly once when a lane drains", async () => {
    const seen: number[] = [];
    const q = createTurnQueue({ onDepth: (_k, d) => seen.push(d) });
    q.enqueue("s1", async () => {});
    await flush();
    expect(seen).toEqual([1, 0]);
  });
});
