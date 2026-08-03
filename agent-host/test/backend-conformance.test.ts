import { createSdkBackend } from "../src/backends/sdk.js";
import type { QueryFn } from "../src/sessionManager.js";
import { runBackendConformance, CONFORMANCE_SPEC } from "./backend-conformance.js";

const query: QueryFn = () =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-conf" };
    yield { type: "result", result: "ok", is_error: false };
  })();

runBackendConformance("sdk", () => createSdkBackend({ query, spec: CONFORMANCE_SPEC }));
