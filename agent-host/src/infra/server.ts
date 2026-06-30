import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appendInfraAudit } from "./audit.js";
import { provisionDatabase } from "./provision.js";
import { PendingActions } from "./pending.js";
import type { ProxmoxClient, AdminExecutor, GatedTool } from "./types.js";

export const GATED_TOOLS: readonly GatedTool[] = [
  "create_vm", "start_vm", "stop_vm", "resize_vm", "destroy_vm", "provision_database",
];
export const READ_TOOL_NAMES: readonly string[] = ["mcp__infra__list_vms", "mcp__infra__vm_status"];

type PermissionResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };
type CanUseTool = (toolName: string, input: Record<string, unknown>, opts: unknown) => Promise<PermissionResult>;

const GATED_TOOL_NAMES = new Set(GATED_TOOLS.map((t) => `mcp__infra__${t}`));

export function makeCanUseTool(deps: { pending: PendingActions; auditPath: string; now: () => string }): CanUseTool {
  return async (toolName, input) => {
    if (!GATED_TOOL_NAMES.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const gatedTool = toolName.replace("mcp__infra__", "") as GatedTool;
    const { decision } = deps.pending.enqueue(gatedTool, input);
    const d = await decision;
    appendInfraAudit(deps.auditPath, { ts: deps.now(), tool: toolName, input, decision: d === "approve" ? "approved" : "denied" });
    return d === "approve"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Operator denied this infrastructure action." };
  };
}

export interface InfraDeps {
  proxmox: ProxmoxClient;
  admin: AdminExecutor;
  dataSourcesPath: string;
  auditPath: string;
  now: () => string;
  password: () => string;
  adminConnectionString?: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

export function createInfraServer(deps: InfraDeps) {
  return createSdkMcpServer({
    name: "infra",
    version: "1.0.0",
    tools: [
      tool("list_vms", "List Proxmox VMs and their status", {}, async () => {
        try { return ok(JSON.stringify(await deps.proxmox.listVms())); } catch (e) { return fail(String(e)); }
      }),
      tool("vm_status", "Get one VM's status", { id: z.number().int() }, async (a) => {
        try { return ok(JSON.stringify(await deps.proxmox.status(a.id))); } catch (e) { return fail(String(e)); }
      }),
      tool("create_vm", "Create a VM", { name: z.string(), cores: z.number().int().default(1), memory: z.number().int().default(1024) }, async (a) => {
        try { return ok(JSON.stringify(await deps.proxmox.create(a))); } catch (e) { return fail(String(e)); }
      }),
      tool("start_vm", "Start a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.start(a.id); return ok(`started ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("stop_vm", "Stop a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.stop(a.id); return ok(`stopped ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("resize_vm", "Resize a VM's cores/memory", { id: z.number().int(), cores: z.number().int().optional(), memory: z.number().int().optional() }, async (a) => {
        try { await deps.proxmox.resize(a.id, { cores: a.cores, memory: a.memory }); return ok(`resized ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("destroy_vm", "Destroy a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.destroy(a.id); return ok(`destroyed ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("provision_database", "Create a Postgres database and register it as a data source", { name: z.string() }, async (a) => {
        try {
          const entry = await provisionDatabase(
            { admin: deps.admin, dataSourcesPath: deps.dataSourcesPath, password: deps.password, adminConnectionString: deps.adminConnectionString },
            a.name,
          );
          return ok(`provisioned database "${entry.id}" and registered it as a data source`);
        } catch (e) { return fail(String(e)); }
      }),
    ],
  });
}
