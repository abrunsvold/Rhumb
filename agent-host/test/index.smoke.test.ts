import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index.js";

describe("buildApp wiring", () => {
  it("builds an app whose /messages drives the injected query and streams a result", async () => {
    const app = buildApp({
      config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok" },
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-7" };
          yield { type: "result", result: "hello world", is_error: false };
        })(),
    });

    const health = await request(app).get("/healthz");
    expect(health.status).toBe(200);

    const posted = await request(app).post("/messages").send({ prompt: "hi" });
    expect(posted.status).toBe(202);
  });
});
