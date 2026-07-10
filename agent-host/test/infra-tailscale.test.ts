import { describe, it, expect } from "vitest";
import { buildAuthKeyRequest, createTailscaleClient, AUTH_KEY_EXPIRY_SECONDS } from "../src/infra/tailscale.js";

const cfg = { apiKey: "tskey-api-TEST", tailnet: "example.com" };

describe("buildAuthKeyRequest", () => {
  it("targets the tailnet keys endpoint with basic auth", () => {
    const { url, init } = buildAuthKeyRequest(cfg, { description: "cfusion-node-01" });
    expect(url).toBe("https://api.tailscale.com/api/v2/tailnet/example.com/keys");
    expect(init.method).toBe("POST");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("tskey-api-TEST:").toString("base64")}`);
  });

  it("encodes the tailnet name", () => {
    const { url } = buildAuthKeyRequest({ ...cfg, tailnet: "user@github" }, { description: "d" });
    expect(url).toContain("/tailnet/user%40github/keys");
  });

  it("requests a one-time, preauthorized, non-ephemeral key with expiry", () => {
    const { init } = buildAuthKeyRequest(cfg, { description: "cfusion-node-01" });
    const body = JSON.parse(init.body as string);
    expect(body.capabilities.devices.create).toMatchObject({ reusable: false, ephemeral: false, preauthorized: true });
    expect(body.capabilities.devices.create.tags).toBeUndefined();
    expect(body.expirySeconds).toBe(AUTH_KEY_EXPIRY_SECONDS);
    expect(body.description).toBe("cfusion-node-01");
  });

  it("passes tags through when given", () => {
    const { init } = buildAuthKeyRequest(cfg, { description: "d", tags: ["tag:cfusion"] });
    expect(JSON.parse(init.body as string).capabilities.devices.create.tags).toEqual(["tag:cfusion"]);
  });
});

describe("createTailscaleClient", () => {
  it("returns the minted key on success", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ id: "k123", key: "tskey-auth-SECRET" }),
    })) as unknown as typeof fetch;
    const client = createTailscaleClient(cfg, fakeFetch);
    await expect(client.createAuthKey({ description: "d" })).resolves.toEqual({ key: "tskey-auth-SECRET" });
  });

  it("throws with status and body on an API error", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    })) as unknown as typeof fetch;
    const client = createTailscaleClient(cfg, fakeFetch);
    await expect(client.createAuthKey({ description: "d" })).rejects.toThrow(/403.*forbidden/);
  });

  it("throws when the response carries no key", async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const client = createTailscaleClient(cfg, fakeFetch);
    await expect(client.createAuthKey({ description: "d" })).rejects.toThrow(/no key/);
  });
});
