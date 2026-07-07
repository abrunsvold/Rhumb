import pg from "pg";
import type { AdminExecutor } from "./types.js";

export function createAdminExecutor(connectionString: string): AdminExecutor {
  const pool = new pg.Pool({ connectionString });
  return {
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}

// Build an admin connection string for another database on the same server by
// swapping the URL path. Used to point a superuser executor at a freshly
// provisioned DB (event triggers are per-database). dbName is IDENT-validated
// upstream in provisionDatabase.
export function connStringForDb(adminConnectionString: string, dbName: string): string {
  const u = new URL(adminConnectionString);
  u.pathname = "/" + dbName;
  return u.toString();
}
