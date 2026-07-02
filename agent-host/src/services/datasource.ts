import { readFileSync } from "node:fs";

interface DataSourceEntry {
  id: string;
  connectionString?: string;
}

// Resolve a data-source id to its connection string from data-sources.json.
// Reads fresh each call so sources provisioned after startup are seen; a missing
// or corrupt file resolves to undefined (spawn without dataSources still works).
export function createDataSourceResolver(path: string): (id: string) => string | undefined {
  return (id: string) => {
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
    if (!Array.isArray(list)) return undefined;
    return (list as DataSourceEntry[]).find((s) => s?.id === id)?.connectionString;
  };
}
