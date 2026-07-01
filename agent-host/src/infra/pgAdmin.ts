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
