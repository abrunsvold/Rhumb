import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appendInfraAudit } from "./audit.js";
import { provisionDatabase } from "./provision.js";
import { PendingActions } from "./pending.js";
import type { ProxmoxClient, AdminExecutor, GatedTool } from "./types.js";
import type { ServiceOps } from "../services/ops.js";

export const GATED_TOOLS: readonly GatedTool[] = [
  "create_vm", "start_vm", "stop_vm", "resize_vm", "destroy_vm", "provision_database",
  "spawn_service", "redeploy_service", "stop_service", "start_service", "destroy_service",
];
export const READ_TOOL_NAMES: readonly string[] = [
  "mcp__infra__list_vms", "mcp__infra__vm_status", "mcp__infra__list_services", "mcp__infra__service_status",
];

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
    let d: "approve" | "deny";
    try {
      d = await decision;
    } catch (e) {
      appendInfraAudit(deps.auditPath, { ts: deps.now(), tool: toolName, input, decision: "error", error: String(e) });
      return { behavior: "deny", message: "Infrastructure action could not be confirmed." };
    }
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
  serviceOps?: ServiceOps;
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
      tool("list_services", "List spawned services and their status", {}, async () => {
        try { return ok(JSON.stringify(deps.serviceOps ? deps.serviceOps.list() : [])); } catch (e) { return fail(String(e)); }
      }),
      tool("service_status", "Get one service's status", { id: z.string() }, async (a) => {
        try { return ok(JSON.stringify(deps.serviceOps?.status(a.id) ?? null)); } catch (e) { return fail(String(e)); }
      }),
      tool("spawn_service", "Provision an LXC, deploy the app from <workspace>/services/<id>, and register it", { id: z.string() }, async (a) => {
        try {
          if (!deps.serviceOps) return fail("services are not configured");
          const entry = await deps.serviceOps.spawn(a.id);
          return ok(`spawned service "${entry.id}" at ${entry.basePath}`);
        } catch (e) { return fail(String(e)); }
      }),
      tool("redeploy_service", "Blue-green replace an EXISTING service: spawn a new container, deploy, health-gate it, cut the registry over, then destroy the old container. The old container is destroyed only after the new one passes its health gate.", { id: z.string() }, async (a) => {
        try {
          if (!deps.serviceOps) return fail("services are not configured");
          const { entry, warning } = await deps.serviceOps.redeploy(a.id);
          return ok(`redeployed "${entry.id}" (deploy ${entry.deployId}, container ${entry.containerId})${warning ? ` — WARNING: ${warning}` : ""}`);
        } catch (e) { return fail(String(e)); }
      }),
      tool("stop_service", "Stop a service's container", { id: z.string() }, async (a) => {
        try { if (!deps.serviceOps) return fail("services are not configured"); await deps.serviceOps.stop(a.id); return ok(`stopped ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("start_service", "Start a service's container", { id: z.string() }, async (a) => {
        try { if (!deps.serviceOps) return fail("services are not configured"); await deps.serviceOps.start(a.id); return ok(`started ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("destroy_service", "Stop, destroy, and deregister a service", { id: z.string() }, async (a) => {
        try { if (!deps.serviceOps) return fail("services are not configured"); await deps.serviceOps.destroy(a.id); return ok(`destroyed ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
    ],
  });
}
