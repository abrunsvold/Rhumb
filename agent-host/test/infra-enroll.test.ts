import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollFleetNode, buildEnrollCommand } from "../src/infra/enroll.js";
import type { TailscaleClient } from "../src/infra/tailscale.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-enroll-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeDeps() {
  const upserts: Array<Record<string, unknown>> = [];
  const calls: Array<{ description: string; tags?: string[] }> = [];
  const tailscale: TailscaleClient = {
    createAuthKey: async (opts) => {
      calls.push(opts);
      return { key: "tskey-auth-SECRET" };
    },
  };
  return {
    calls,
    upserts,
    deps: {
      tailscale,
      ontology: { upsert: (n: Record<string, unknown>) => { upserts.push(n); return n; } },
      auditPath: join(dir, "infra-audit.jsonl"),
      now: () => "T",
    },
  };
}

describe("buildEnrollCommand", () => {
  it("is the exact setup-device.sh invocation, referencing $TS_AUTH_KEY rather than a literal key", () => {
    expect(buildEnrollCommand("node-01")).toBe(
      "TS_AUTH_KEY=\"$TS_AUTH_KEY\" FLEET_NODE_ID='node-01' FLEET_CENTRAL_HOST=<central-broker-host> ./scripts/setup-device.sh <device-ip>",
    );
  });
});

describe("enrollFleetNode", () => {
  it("mints a key, records the ontology node, audits, and returns the command", async () => {
    const { deps, calls, upserts } = fakeDeps();
    const r = await enrollFleetNode(deps, { nodeId: "node-01", tags: ["tag:cfusion"] });
    expect(r.nodeId).toBe("node-01");
    expect(r.authKey).toBe("tskey-auth-SECRET");
    expect(r.enrollCommand).toContain("./scripts/setup-device.sh");
    expect(r.enrollCommand).toContain('TS_AUTH_KEY="$TS_AUTH_KEY"');
    expect(r.enrollCommand).not.toContain("tskey-auth-SECRET");
    expect(r.enrollCommand).toContain("FLEET_NODE_ID='node-01'");
    // key minted for this node, tags passed through
    expect(calls).toEqual([{ description: "cfusion-node-01", tags: ["tag:cfusion"] }]);
    // ontology entity recorded
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: "cfusion-node-01",
      subtype: "fleet-node",
      props: { nodeId: "node-01", tags: "tag:cfusion", enrolledAt: "T" },
    });
    // audited — without the key
    const line = JSON.parse(readFileSync(deps.auditPath, "utf8").trim());
    expect(line).toMatchObject({ tool: "mcp__infra__enroll_fleet_node", decision: "approved" });
    expect(readFileSync(deps.auditPath, "utf8")).not.toContain("tskey-auth-SECRET");
  });

  it("rejects an invalid node id before minting anything", async () => {
    const { deps, calls } = fakeDeps();
    await expect(enrollFleetNode(deps, { nodeId: "bad id!" })).rejects.toThrow(/invalid node id/);
    expect(calls).toHaveLength(0);
    expect(existsSync(deps.auditPath)).toBe(false);
  });

  it("records nothing when the key mint fails", async () => {
    const { deps, upserts } = fakeDeps();
    deps.tailscale = { createAuthKey: async () => { throw new Error("api down"); } };
    await expect(enrollFleetNode(deps, { nodeId: "node-01" })).rejects.toThrow(/api down/);
    expect(upserts).toHaveLength(0);
    expect(existsSync(deps.auditPath)).toBe(false);
  });

  it("omits the tags prop when no tags are given", async () => {
    const { deps, upserts } = fakeDeps();
    await enrollFleetNode(deps, { nodeId: "node-02" });
    expect((upserts[0].props as Record<string, string>).tags).toBeUndefined();
  });
});
