import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { createServiceProxy } from "../src/services/proxy.js";

let upstream: Server | undefined;
afterEach(() => { upstream?.close(); upstream = undefined; });

function appWith(services: any[]) {
  const a = express();
  a.use("/services", createServiceProxy({ getServices: () => services }));
  return a;
}

describe("service reverse proxy", () => {
  it("proxies /services/:id/<rest> to the container root", async () => {
    await new Promise<void>((resolve) => {
      upstream = createServer((req, res) => { res.end(`upstream saw ${req.url}`); }).listen(0, resolve);
    });
    const port = (upstream!.address() as any).port;
    const res = await request(appWith([{ id: "sales", host: "127.0.0.1", port }])).get("/services/sales/api/ping");
    expect(res.status).toBe(200);
    expect(res.text).toBe("upstream saw /api/ping");
  });

  it("404 for an unknown service id", async () => {
    const res = await request(appWith([])).get("/services/nope/");
    expect(res.status).toBe(404);
  });

  it("502 when the upstream is unreachable", async () => {
    // port 1 is not listening → connection refused
    const res = await request(appWith([{ id: "dead", host: "127.0.0.1", port: 1 }])).get("/services/dead/");
    expect(res.status).toBe(502);
  });
});
