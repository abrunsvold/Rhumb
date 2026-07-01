# Compliance & intended-use notes

This document explains why RHUMBR is shaped the way it is. It is not legal advice;
it is the project's design intent and the reasoning behind it. If you operate
RHUMBR in a way that differs from the personal-tool model below, you are
responsible for clearing that with the relevant providers yourself.

## The core constraint

RHUMBR authenticates Claude with the **operator's own Claude subscription**, via a
long-lived OAuth token produced by `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
It never uses a pay-per-token API key, and it never holds anyone's credentials but
the operator's own.

Anthropic's terms of service restrict third-party developers from **offering**
claude.ai login or claude.ai rate limits within their own products — including
agents built on the Claude Agent SDK — without prior approval. The operative verb
is **offer**: the restriction is about exposing *your* Claude access (or a login to
it) *to other people* as part of a product or service.

## How RHUMBR stays inside that line

RHUMBR is built and distributed as a **self-hosted personal tool**, not a product or
service:

- **One operator, their own credentials.** Each person who runs RHUMBR supplies
  their own `CLAUDE_CODE_OAUTH_TOKEN` and runs the software on their own hardware.
- **No brokering.** RHUMBR does not proxy, multiplex, resell, or otherwise expose
  Claude login or rate limits to third parties. There is no "sign in with Claude"
  flow for end users.
- **No hosted offering.** There is no hosted RHUMBR service. The project ships
  source code that an operator runs for themselves.
- **Open source ≠ a distributed product.** Publishing source under Apache-2.0 so
  others can read, run, and adapt it for *their own* self-hosted use is distinct
  from operating a product built around claude.ai login. The former is the intent;
  the latter is what the terms restrict.

## If you want to go further

Building a **multi-tenant or hosted** offering on top of RHUMBR — anything where
people who are not the operator reach Claude through your deployment — moves outside
this personal-tool model. **Seek Anthropic's approval first.** That is your
responsibility, not something this license or this repository grants you.

## Network & data posture (related, not legal)

These are operational rules that reinforce the personal-tool posture:

- Expose RHUMBR **only over your Tailscale tailnet**, never on a public interface.
- The dashboard host is **unauthenticated** and serves whatever is in the workspace.
- The agent host runs Claude Code **autonomously** with Bash/Write access; choose
  `RHUMBR_PERMISSION_MODE` deliberately and avoid `bypassPermissions` outside
  trusted, isolated environments.

See [`README.md`](README.md) and [`agent-host/README.md`](agent-host/README.md) for
the full security model.

## Trademarks

Apache-2.0 grants no rights to the trademarks of Anthropic, Tailscale, Proxmox, or
any other third party. References to those names in this project are nominative —
they describe what RHUMBR integrates with and imply no endorsement.
