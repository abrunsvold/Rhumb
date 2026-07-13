import { provisionDatabase } from "./provision.js";
import type { GatedTool } from "./types.js";
import type { InfraDeps } from "./server.js";

// The single place a gated tool's effect actually runs. Shared by the MCP
// tool handlers (blocking gate, in-turn) and the infra router's
// execute-on-approve path (parked gate, background) — so an approved parked
// action does exactly what the same tool would have done in-turn, including
// which operations fire the onMutate hook (ontology auto-sync).
export interface GatedExecutor {
  execute(tool: GatedTool, input: Record<string, unknown>): Promise<string>;
}

export function createGatedExecutor(deps: InfraDeps): GatedExecutor {
  const mutated = () => { try { deps.onMutate?.(); } catch { /* never affects the result */ } };
  const svc = () => {
    if (!deps.serviceOps) throw new Error("services are not configured");
    return deps.serviceOps;
  };

  return {
    async execute(tool, input) {
      switch (tool) {
        case "create_vm": {
          const r = await deps.proxmox.create(input as { name: string; cores: number; memory: number });
          mutated();
          return JSON.stringify(r);
        }
        case "start_vm": {
          await deps.proxmox.start(input.id as number);
          return `started ${input.id}`;
        }
        case "stop_vm": {
          await deps.proxmox.stop(input.id as number);
          return `stopped ${input.id}`;
        }
        case "resize_vm": {
          await deps.proxmox.resize(input.id as number, { cores: input.cores as number | undefined, memory: input.memory as number | undefined });
          return `resized ${input.id}`;
        }
        case "destroy_vm": {
          await deps.proxmox.destroy(input.id as number);
          mutated();
          return `destroyed ${input.id}`;
        }
        case "provision_database": {
          const entry = await provisionDatabase(
            { admin: deps.admin, adminExecForDb: deps.adminExecForDb, dataSourcesPath: deps.dataSourcesPath, password: deps.password, adminConnectionString: deps.adminConnectionString },
            input.name as string,
          );
          mutated();
          return `provisioned database "${entry.id}" and registered it as a data source`;
        }
        case "spawn_service": {
          const entry = await svc().spawn(input.id as string);
          mutated();
          return `spawned service "${entry.id}" at ${entry.basePath}`;
        }
        case "redeploy_service": {
          const { entry, warning } = await svc().redeploy(input.id as string);
          mutated();
          return `redeployed "${entry.id}" (deploy ${entry.deployId}, container ${entry.containerId})${warning ? ` — WARNING: ${warning}` : ""}`;
        }
        case "stop_service": {
          await svc().stop(input.id as string);
          mutated();
          return `stopped ${input.id}`;
        }
        case "start_service": {
          await svc().start(input.id as string);
          mutated();
          return `started ${input.id}`;
        }
        case "destroy_service": {
          await svc().destroy(input.id as string);
          mutated();
          return `destroyed ${input.id}`;
        }
        default:
          throw new Error(`unknown gated tool: ${String(tool)}`);
      }
    },
  };
}
