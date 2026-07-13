import { describe, it, expect, vi } from "vitest";
import { createGatedExecutor } from "../src/infra/executor.js";
import type { InfraDeps } from "../src/infra/server.js";

function deps(over: Partial<InfraDeps> = {}): { d: InfraDeps; onMutate: ReturnType<typeof vi.fn> } {
  const onMutate = vi.fn();
  const d = {
    proxmox: {
      listVms: vi.fn(), status: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 201 }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    admin: { exec: vi.fn() },
    dataSourcesPath: "/tmp/nope.json",
    auditPath: "/tmp/nope.jsonl",
    now: () => "T",
    password: () => "pw",
    adminExecForDb: () => ({ exec: vi.fn() }),
    serviceOps: {
      list: vi.fn(), status: vi.fn(),
      spawn: vi.fn().mockResolvedValue({ id: "svc", basePath: "/services/svc" }),
      redeploy: vi.fn().mockResolvedValue({ entry: { id: "svc", deployId: "d1", containerId: 106 }, warning: undefined }),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    onMutate,
    ...over,
  } as unknown as InfraDeps;
  return { d, onMutate };
}

describe("createGatedExecutor", () => {
  it("dispatches each tool to its core and returns the tool's success text", async () => {
    const { d } = deps();
    const x = createGatedExecutor(d);
    expect(await x.execute("create_vm", { name: "b", cores: 1, memory: 512 })).toBe(JSON.stringify({ id: 201 }));
    expect(await x.execute("start_vm", { id: 7 })).toBe("started 7");
    expect(await x.execute("start_service", { id: "poller" })).toBe("started poller");
    expect(await x.execute("redeploy_service", { id: "svc" })).toContain("redeployed \"svc\"");
  });

  it("fires onMutate for exactly the mutating tools (not vm start/stop/resize)", async () => {
    const { d, onMutate } = deps();
    const x = createGatedExecutor(d);
    await x.execute("start_vm", { id: 1 });
    await x.execute("stop_vm", { id: 1 });
    await x.execute("resize_vm", { id: 1, cores: 2 });
    expect(onMutate).not.toHaveBeenCalled();
    await x.execute("destroy_vm", { id: 1 });
    expect(onMutate).toHaveBeenCalledTimes(1);
    await x.execute("start_service", { id: "p" });
    expect(onMutate).toHaveBeenCalledTimes(2);
  });

  it("propagates failures and preserves the services-not-configured error", async () => {
    const { d } = deps({ serviceOps: undefined });
    const x = createGatedExecutor(d);
    await expect(x.execute("spawn_service", { id: "s" })).rejects.toThrow(/services are not configured/);
    const { d: d2 } = deps();
    (d2.proxmox.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("pve down"));
    await expect(x.execute("nonsense" as never, {})).rejects.toThrow(/unknown gated tool/);
    await expect(createGatedExecutor(d2).execute("destroy_vm", { id: 1 })).rejects.toThrow("pve down");
  });
});
