# Manual setup

The [README quickstart](../README.md#quickstart) (`sudo scripts/install.sh`) is the
recommended path on a Linux box. This page is for everything else: macOS, boxes
without systemd, understanding what the installer does, and local development
without a tailnet.

You'll need [Node.js](https://nodejs.org) 20+, Claude credentials (a subscription,
an API key, or an Anthropic-compatible gateway), and (for the intended setup) a
Tailscale tailnet.

## Manual setup

### 1. Choose a credential mode

Rhumb authenticates Claude one of three ways, set with `RHUMB_LLM_PROVIDER`:

```sh
# subscription (default) — uses your Claude subscription
claude setup-token        # produces a long-lived CLAUDE_CODE_OAUTH_TOKEN

# api-key — pay-per-token API access
export RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY=sk-ant-...

# gateway — any Anthropic-compatible endpoint, including self-hosted models
export RHUMB_LLM_PROVIDER=gateway \
       ANTHROPIC_BASE_URL=https://gateway.internal:4000 \
       ANTHROPIC_AUTH_TOKEN=...   # required — use `none` if your gateway needs no auth
export RHUMB_MODEL=qwen3-coder    # required in gateway mode — no default is safe
```

> **`ANTHROPIC_AUTH_TOKEN` is mandatory in gateway mode, and `none` is a real
> value — not the same as leaving it unset.** The agent host refuses to start if
> it is empty. Here is why: Claude Code builds the gateway's `Authorization`
> header from `ANTHROPIC_AUTH_TOKEN`, and when that variable is absent it falls
> back to the claude.ai OAuth credential stored on the box (macOS keychain or
> `~/.claude/.credentials.json`) — so a gateway you configured "without auth"
> would receive your personal claude.ai login as
> `Authorization: Bearer sk-ant-oat01-...`. Environment sanitising cannot stop
> that, because the fallback reads the on-disk credential store rather than the
> environment. Setting `ANTHROPIC_AUTH_TOKEN=none` makes Rhumb inject a
> non-credential placeholder (`rhumb-no-auth`) into the agent's environment
> instead, which keeps the CLI from ever consulting your stored login. Only use
> `none` if your gateway is genuinely auth-free — i.e. it performs no bearer-token
> check at all. A gateway that does validate bearer tokens will reject the
> placeholder with `401 Unauthorized`, not silently ignore it.

> **Gateway mode needs an Anthropic-compatible endpoint.** Rhumb drives Claude Code
> through `@anthropic-ai/claude-agent-sdk`, which speaks the Anthropic Messages
> API. OpenRouter and most local servers (ollama, vLLM) are OpenAI-compatible, so
> put a translating proxy in front — [LiteLLM](https://github.com/BerriAI/litellm),
> claude-code-router, or equivalent. Rhumb does not translate protocols itself.

> **Tool-calling fidelity is the real limiter on open models.** Rhumb's agent loop
> is tool-heavy: it provisions databases, spawns services, and writes through a
> gated approval path. Models that handle prose well often still fail at reliable
> multi-step tool use, and that shows up as an agent that stalls or loops rather
> than one that writes bad text. Test with a small build before committing.

### 2. Put both hosts behind `tailscale serve`

On the box, run the setup script once. It mounts both hosts behind a single
tailnet HTTPS origin and prints the tailnet login(s) to allowlist:

```sh
scripts/setup-serve.sh
```

> **First run:** if `tailscale serve` has never been used on your tailnet, the
> script pauses and prints a `login.tailscale.com` link — a tailnet admin must
> click it once to enable Serve (and HTTPS certificates, if prompted) before
> setup can continue.

### 3. Set the allowlist and run the agent host

`RHUMB_ALLOWED_USERS` is a comma-separated list of tailnet logins (e.g.
`alice@github`) permitted to reach the hosts. Set it on **both** hosts — they
refuse to start without it:

```sh
cd agent-host
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start   # or the api-key / gateway vars above
```

Defaults: port `8787`, provider `subscription`, model `claude-opus-4-8`
(subscription and api-key modes only), workspace `./workspace`, permission mode
`acceptEdits`. The host binds loopback only — `tailscale serve` is what makes it
reachable from the tailnet. See [`agent-host/README.md`](../agent-host/README.md)
for all environment variables and the security model behind permission modes.

### 4. Run the dashboard host

Point it at the **same workspace** as the agent host, with the same allowlist:

```sh
cd dashboard-host
npm install
npm run build
RHUMB_WORKSPACE=../agent-host/workspace RHUMB_ALLOWED_USERS=you@github npm start
```

Defaults: port `8788`, loopback bind. See
[`dashboard-host/README.md`](../dashboard-host/README.md).

### 5. Keep them running

Nothing above survives a reboot. On systemd Linux, `sudo scripts/install.sh`
sets up `rhumb-agent.service` and `rhumb-dashboard.service` for you (it is safe
to run after a manual setup — your env values can be re-entered at the prompts,
and from then on configuration lives in `/etc/rhumb/rhumb.env`). The units are
rendered from the templates in [`scripts/systemd/`](../scripts/systemd/); read
those if you'd rather install the units by hand. On other platforms, use your
process supervisor of choice pointed at `npm start` in each package with the
environment variables above.

`tailscale serve` state persists on its own, so once the units are enabled the
whole path — tailnet, serve, hosts, surfaces — comes back after a reboot with
no login and no manual step. Check on them with:

```sh
systemctl status rhumb-agent rhumb-dashboard
journalctl -u rhumb-agent -f
```

## Local development without a tailnet

Set `RHUMB_INSECURE_DEV=1` on both hosts to skip identity checks and the
loopback-only bind entirely — useful for running everything on one machine
without Tailscale. **Never set this on a box reachable by anyone else**: it
disables the Tailscale identity allowlist and all of the request
authentication described in [`SECURITY.md`](../SECURITY.md).

Note that the desktop client can't connect to bare two-port `RHUMB_INSECURE_DEV`
hosts as-is: it speaks to a single HTTPS origin (`/` for the dashboard host,
`/agent` for the agent host), which normally comes from `tailscale serve`. For
local development without a tailnet, either run `tailscale serve` locally or
put a reverse proxy in front that maps `/` → `:8788` and `/agent` → `:8787`.
`RHUMB_INSECURE_DEV` hosts on their own (without that single-origin front end)
are meant to be exercised directly via `curl`/`supertest`, not the desktop client.

## Troubleshooting

- **`tailscale serve` prints a `login.tailscale.com` link and waits** — Serve
  isn't enabled on your tailnet yet. A tailnet admin must click the link once;
  then re-run.
- **HTTPS certificate errors on first request** — enable MagicDNS + HTTPS
  certificates for your tailnet: <https://login.tailscale.com/admin/dns>.
- **A host exits immediately with `RHUMB_ALLOWED_USERS is required`** — both
  hosts fail closed without an identity allowlist. Set it (comma-separated
  tailnet logins, e.g. `alice@github`), or `RHUMB_INSECURE_DEV=1` for local
  dev only.
- **Installer says a unit is not running** — read the log it points at:
  `journalctl -u rhumb-agent -n 50` (or `rhumb-dashboard`). Fix the cause
  (most often a bad token or a port collision) and re-run
  `sudo scripts/install.sh` — it's idempotent.
- **The desktop client's discovery finds nothing** — discovery needs the
  `tailscale` CLI on your laptop. Without it, enter the box's HTTPS origin
  (`https://<box>.<tailnet>.ts.net`) manually in the picker.
- **Changed a value in `/etc/rhumb/rhumb.env`** — apply it with
  `sudo systemctl restart rhumb-agent rhumb-dashboard` (or re-run the
  installer).
