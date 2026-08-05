// Per-session FIFO. Rooms accept messages whenever — the composer never locks
// and POST /messages never returns 409 — so concurrent senders are serialized
// here instead of racing two `manager.run` calls onto one session, which forks
// the transcript.
//
// A lane is keyed by session id, with "" as the pending bucket for a room whose
// session id has not arrived yet. This mirrors the `subscribers` map in
// server.ts, which re-keys the same way when the `session` event lands.

interface Lane {
  items: Array<() => Promise<void>>;
  running: boolean;
}

export interface TurnQueue {
  /** Appends a turn to its lane and returns the lane's new depth. */
  enqueue(key: string, run: () => Promise<void>): number;
  /** Moves a lane to its real session id once that id is known. */
  rekey(from: string, to: string): void;
  depth(key: string): number;
}

export function createTurnQueue(deps: {
  onDepth: (key: string, depth: number) => void;
}): TurnQueue {
  const lanes = new Map<string, Lane>();
  // Old key -> canonical key. A drain started under "" resolves through this on
  // every step, so it keeps draining the same lane after the rekey.
  const alias = new Map<string, string>();

  const canon = (key: string): string => alias.get(key) ?? key;

  function laneFor(key: string): Lane {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { items: [], running: false };
      lanes.set(key, lane);
    }
    return lane;
  }

  const depthOf = (lane: Lane): number => lane.items.length + (lane.running ? 1 : 0);

  async function drain(key: string): Promise<void> {
    const k = canon(key);
    const lane = lanes.get(k);
    if (!lane || lane.running) return;
    const next = lane.items.shift();
    if (!next) {
      // Depth 0 was already emitted by the finally below; dropping the lane
      // here keeps the map from growing one entry per room forever.
      lanes.delete(k);
      return;
    }
    lane.running = true;
    try {
      await next();
    } catch {
      // A failed turn must advance the lane, never wedge it. The turn's own
      // error already reached the room as an `error` event.
    } finally {
      lane.running = false;
      deps.onDepth(canon(k), depthOf(lane));
      void drain(k);
    }
  }

  return {
    enqueue(key, run) {
      const k = canon(key);
      const lane = laneFor(k);
      lane.items.push(run);
      const d = depthOf(lane);
      deps.onDepth(k, d);
      void drain(k);
      return d;
    },

    rekey(from, to) {
      const f = canon(from);
      const t = canon(to);
      if (f === t) return;
      const src = lanes.get(f);
      const dst = lanes.get(t);
      if (src && dst) {
        // Defensive: `to` normally has no lane yet, because a session id is new
        // the first time it arrives. If both exist, the source is older, so its
        // items go first.
        dst.items.unshift(...src.items);
        dst.running = dst.running || src.running;
        lanes.delete(f);
      } else if (src) {
        // Move the same Lane object, so an in-flight drain keeps mutating the
        // lane it is actually running on.
        lanes.set(t, src);
        lanes.delete(f);
      }
      alias.set(from, t);
      alias.set(f, t);
      void drain(t);
    },

    depth(key) {
      const lane = lanes.get(canon(key));
      return lane ? depthOf(lane) : 0;
    },
  };
}
