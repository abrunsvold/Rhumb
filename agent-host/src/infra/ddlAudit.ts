import type { AdminExecutor } from "./types.js";

// Idempotent install of the DDL-audit backstop for ONE database. Event triggers
// are superuser-only to create/drop and the functions/table are superuser-owned,
// so an agent connecting with a database's owner role cannot remove or tamper
// with the record. The functions are SECURITY DEFINER (they insert as the
// superuser even when fired by an owner-role DDL statement) and record
// session_user — the role that authenticated the connection — as the actor;
// current_user would be the definer (superuser) and is therefore wrong here.
// Order matters: table -> functions -> triggers, so no trigger fires before its
// function/table exist and the install's own DDL is not self-logged.
export const DDL_AUDIT_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public._rhumb_ddl_audit (
     id              bigserial PRIMARY KEY,
     ts              timestamptz NOT NULL DEFAULT now(),
     actor           text NOT NULL DEFAULT session_user,
     command_tag     text,
     object_type     text,
     object_identity text
   )`,
  `CREATE OR REPLACE FUNCTION public._rhumb_log_ddl() RETURNS event_trigger
   LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $rhumb$
   DECLARE r record;
   BEGIN
     FOR r IN SELECT command_tag, object_type, object_identity
              FROM pg_event_trigger_ddl_commands() LOOP
       INSERT INTO public._rhumb_ddl_audit(actor, command_tag, object_type, object_identity)
       VALUES (session_user, r.command_tag, r.object_type, r.object_identity);
     END LOOP;
   END $rhumb$`,
  `CREATE OR REPLACE FUNCTION public._rhumb_log_drop() RETURNS event_trigger
   LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $rhumb$
   DECLARE r record;
   BEGIN
     FOR r IN SELECT object_type, object_identity
              FROM pg_event_trigger_dropped_objects() LOOP
       INSERT INTO public._rhumb_ddl_audit(actor, command_tag, object_type, object_identity)
       VALUES (session_user, TG_TAG, r.object_type, r.object_identity);
     END LOOP;
   END $rhumb$`,
  `DROP EVENT TRIGGER IF EXISTS _rhumb_ddl_audit_end`,
  `CREATE EVENT TRIGGER _rhumb_ddl_audit_end ON ddl_command_end
     EXECUTE FUNCTION public._rhumb_log_ddl()`,
  `DROP EVENT TRIGGER IF EXISTS _rhumb_ddl_audit_drop`,
  `CREATE EVENT TRIGGER _rhumb_ddl_audit_drop ON sql_drop
     EXECUTE FUNCTION public._rhumb_log_drop()`,
];

// Run the install against a superuser executor already pointed at the target
// database (event triggers are per-database). Statements run in array order; any
// failure propagates so the caller can abort provisioning.
export async function ensureDdlAudit(exec: AdminExecutor): Promise<void> {
  for (const sql of DDL_AUDIT_STATEMENTS) {
    await exec.exec(sql);
  }
}
