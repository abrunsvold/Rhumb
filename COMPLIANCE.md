# Compliance & intended-use notes

This document explains why Rhumb is shaped the way it is. It is not legal advice;
it is the project's design intent and the reasoning behind it. If you operate
Rhumb in a way that differs from the personal-tool model below, you are
responsible for clearing that with the relevant providers yourself.

## The core constraint

Rhumb supports three credential modes (`RHUMB_LLM_PROVIDER`): `subscription`,
`api-key`, and `gateway`. **This document's constraint applies to `subscription`
mode only.**

In subscription mode, Rhumb authenticates Claude with the **operator's own Claude
subscription**, via a long-lived OAuth token produced by `claude setup-token`
(`CLAUDE_CODE_OAUTH_TOKEN`).

Anthropic's terms of service restrict third-party developers from **offering**
claude.ai login or claude.ai rate limits within their own products — including
agents built on the Claude Agent SDK — without prior approval. The operative verb
is **offer**: the restriction is about exposing *your* Claude access (or a login to
it) *to other people* as part of a product or service.

In `api-key` and `gateway` mode no claude.ai login or rate limit is involved, so
this restriction does not apply. Those deployments are governed by the terms you
hold with whoever supplies the credentials — Anthropic, your cloud provider, or
nobody at all if you are serving a self-hosted model.

That claim about gateway mode holds because Rhumb *enforces* it, not merely by
convention. Claude Code, given a gateway base URL but no `ANTHROPIC_AUTH_TOKEN`,
falls back to the claude.ai OAuth credential stored on the box and sends it to
the gateway — which would put a claude.ai login into a deployment documented as
having none. So the agent host requires `ANTHROPIC_AUTH_TOKEN` in gateway mode
and refuses to start without it; operators of auth-free gateways set it to the
literal `none`, which makes Rhumb inject a non-credential placeholder. A gateway
deployment therefore never carries your claude.ai login, and a subscription
credential is used only in `subscription` mode. See
[SECURITY.md](SECURITY.md) and [docs/setup-manual.md](docs/setup-manual.md).

## How Rhumb stays inside that line

In subscription mode, Rhumb is built and distributed as a **self-hosted personal
tool**, not a product or service:

- **One operator, their own credentials.** Each person running Rhumb in
  subscription mode supplies their own `CLAUDE_CODE_OAUTH_TOKEN` and runs the
  software on their own hardware.
- **No brokering.** Rhumb does not proxy, multiplex, resell, or otherwise expose
  Claude login or rate limits to third parties. There is no "sign in with Claude"
  flow for end users.
- **No hosted offering.** There is no hosted Rhumb service. The project ships
  source code that an operator runs for themselves.
- **Open source ≠ a distributed product.** Publishing source under Apache-2.0 so
  others can read, run, and adapt it for *their own* self-hosted use is distinct
  from operating a product built around claude.ai login. The former is the intent;
  the latter is what the terms restrict.

## If you want to go further

Building a **multi-tenant or hosted** offering on top of Rhumb **in subscription
mode** — anything where people who are not the operator reach *your* claude.ai
access through your deployment — moves outside this personal-tool model. **Seek
Anthropic's approval first.** That is your responsibility, not something this
license or this repository grants you.

## Network & data posture (related, not legal)

These are operational rules that reinforce the personal-tool posture:

- Expose Rhumb **only over your Tailscale tailnet**, never on a public interface.
- The dashboard host is **unauthenticated** and serves whatever is in the workspace.
- The agent host runs Claude Code **autonomously** with Bash/Write access; choose
  `RHUMB_PERMISSION_MODE` deliberately and avoid `bypassPermissions` outside
  trusted, isolated environments.

See [`README.md`](README.md) and [`agent-host/README.md`](agent-host/README.md) for
the full security model.

## Trademarks

Apache-2.0 grants no rights to the trademarks of Anthropic, Tailscale, Proxmox, or
any other third party. References to those names in this project are nominative —
they describe what Rhumb integrates with and imply no endorsement.
