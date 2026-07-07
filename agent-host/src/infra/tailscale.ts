// Tailscale admin API client — only what enroll_fleet_node needs: minting a
// one-time pre-auth key. The request builder is pure (unit-testable); the
// client wraps global fetch and is injected so tests never hit the network.
export interface TailscaleClient {
  createAuthKey(opts: { description: string; tags?: string[] }): Promise<{ key: string }>;
}

export interface TailscaleConfig {
  apiKey: string;
  tailnet: string;
}

// Pre-auth keys expire after this long; enrollment is expected to happen
// right after the operator receives the key.
export const AUTH_KEY_EXPIRY_SECONDS = 3600;

export function buildAuthKeyRequest(
  cfg: TailscaleConfig,
  opts: { description: string; tags?: string[] },
): { url: string; init: RequestInit } {
  const body = {
    capabilities: {
      devices: {
        create: {
          reusable: false, // one-time
          ephemeral: false, // fleet nodes are durable devices
          preauthorized: true,
          ...(opts.tags?.length ? { tags: opts.tags } : {}),
        },
      },
    },
    expirySeconds: AUTH_KEY_EXPIRY_SECONDS,
    description: opts.description,
  };
  return {
    url: `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(cfg.tailnet)}/keys`,
    init: {
      method: "POST",
      headers: {
        // Tailscale API keys authenticate as basic auth user with empty password.
        Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function createTailscaleClient(cfg: TailscaleConfig, fetchFn: typeof fetch = fetch): TailscaleClient {
  return {
    async createAuthKey(opts) {
      const { url, init } = buildAuthKeyRequest(cfg, opts);
      const res = await fetchFn(url, init);
      if (!res.ok) throw new Error(`tailscale keys API: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { key?: string };
      if (!data.key) throw new Error("tailscale keys API returned no key");
      return { key: data.key };
    },
  };
}
