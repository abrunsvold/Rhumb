import { describe, it, expect } from "vitest";
import type { AgentEvent, RegistrySnapshot } from "../src/lib/types";

describe("wire types", () => {
  it("AgentEvent and RegistrySnapshot are usable as the host contracts", () => {
    const e: AgentEvent = { type: "session", sessionId: "s1" };
    const snap: RegistrySnapshot = {
      surfaces: [
        { id: "a", title: "A", url: "/surfaces/a/", kind: "file", created: "t", updated: "t" },
      ],
    };
    expect(e.type).toBe("session");
    expect(snap.surfaces[0].url).toBe("/surfaces/a/");
  });
});
