import type { DataOp } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

export function buildSql(op: DataOp): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  switch (op.kind) {
    case "select": {
      let text = `SELECT * FROM ${ident(op.table)}`;
      const whereKeys = op.where ? Object.keys(op.where) : [];
      if (whereKeys.length > 0) {
        const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where![k])}`);
        text += ` WHERE ${conds.join(" AND ")}`;
      }
      if (op.limit !== undefined) text += ` LIMIT ${push(op.limit)}`;
      return { text, params };
    }
    case "insert": {
      const keys = Object.keys(op.values);
      if (keys.length === 0) throw new Error("insert requires values");
      const cols = keys.map(ident).join(", ");
      const vals = keys.map((k) => push(op.values[k])).join(", ");
      return { text: `INSERT INTO ${ident(op.table)} (${cols}) VALUES (${vals})`, params };
    }
    case "update": {
      const setKeys = Object.keys(op.values);
      const whereKeys = Object.keys(op.where);
      if (setKeys.length === 0) throw new Error("update requires values");
      if (whereKeys.length === 0) throw new Error("update requires a where clause");
      const sets = setKeys.map((k) => `${ident(k)} = ${push(op.values[k])}`).join(", ");
      const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where[k])}`).join(" AND ");
      return { text: `UPDATE ${ident(op.table)} SET ${sets} WHERE ${conds}`, params };
    }
    case "delete": {
      const whereKeys = Object.keys(op.where);
      if (whereKeys.length === 0) throw new Error("delete requires a where clause");
      const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where[k])}`).join(" AND ");
      return { text: `DELETE FROM ${ident(op.table)} WHERE ${conds}`, params };
    }
    default:
      throw new Error(`unsupported op kind: ${(op as { kind?: string }).kind}`);
  }
}
