# Pluggable LLM provider — design

**Date:** 2026-07-21
**Status:** approved, ready for implementation planning

## Problem

Rhumb hard-codes one way to authenticate Claude: a subscription OAuth token from
`claude setup-token`. `loadConfig` refuses to start without
`CLAUDE_CODE_OAUTH_TOKEN` (`agent-host/src/config.ts:20`), and `sanitizedEnv`
deletes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` specifically to force
subscription auth (`agent-host/src/env.ts`).

That single choice propagates outward into the project's identity. `COMPLIANCE.md`
treats subscription auth as "the core constraint" and derives the whole
single-operator, personal-tool posture from it — because Anthropic's terms restrict
*offering* claude.ai login or rate limits to other people. The constraint is real,
but it is a property of **one credential mode**, not of Rhumb's architecture. Anyone
running Rhumb against their own API key or their own gateway is not offering
claude.ai access to anybody, and nothing about the personal-tool restriction applies
to them.

The result is that Rhumb currently describes itself as more constrained than it is,
and cannot be deployed at all by the users who most need it: organizations that will
never authenticate with an individual's personal subscription.

## Goal

Make the credential mode an explicit, validated choice. Subscription auth remains
fully supported and remains the default — it simply becomes one option among three
rather than an architectural given.

## Non-goals

- **Bedrock / Vertex.** Deferred. The `ProviderId` union makes them additive later.
- **Runtime provider switching.** Changing provider requires a restart.
- **Multi-provider routing / fallback.** One provider per host process.
- **Positioning rewrite.** README lede and `docs/positioning.md` keep their current
  framing; this change corrects accuracy only.

## Design

### 1. Provider abstraction — new `agent-host/src/provider.ts`

```ts
export type ProviderId = "subscription" | "api-key" | "gateway";

export interface ProviderConfig {
  id: ProviderId;
  model: string;
  /** Exactly the credential vars handed to the spawned Claude Code process. */
  credentialEnv: Record<string, string>;
}

export function loadProvider(env: NodeJS.ProcessEnv): ProviderConfig;
```

Selection is explicit via `RHUMB_LLM_PROVIDER`:

| Value | Required vars | Optional | Model default |
|---|---|---|---|
| `subscription` (default when unset) | `CLAUDE_CODE_OAUTH_TOKEN` | — | `claude-opus-4-8` |
| `api-key` | `ANTHROPIC_API_KEY` | — | `claude-opus-4-8` |
| `gateway` | `ANTHROPIC_BASE_URL`, `RHUMB_MODEL` | `ANTHROPIC_AUTH_TOKEN` | none — fails closed |

Rules:

- **Unset `RHUMB_LLM_PROVIDER` means `subscription`.** Every existing install —
  including the deployed box, whose `/etc/rhumb/rhumb.env` predates this change —
  keeps booting with identical behavior. This is the one place we accept implicitness,
  and we accept it because the alternative breaks live deployments on redeploy.
- **`gateway` has no model default.** `claude-opus-4-8` against a proxy serving Qwen
  or Llama is a silent misconfiguration that surfaces as confusing model errors much
  later. Requiring `RHUMB_MODEL` makes it a startup failure instead.
- **`ANTHROPIC_BASE_URL` must parse as an `http:` or `https:` URL.** Reject anything
  else at startup.
- **Unknown `RHUMB_LLM_PROVIDER` values** fail with a message listing the valid ones.
- **Error messages name only the selected mode's missing var.** The current message
  ("Rhumb does not use ANTHROPIC_API_KEY") is deleted.

`Config` loses `oauthToken: string` and `model: string`; it gains
`provider: ProviderConfig`. Model default is provider-coupled, so it cannot stay an
independent field.

### 2. `sanitizedEnv` becomes allowlist-driven

```ts
export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
  credentialEnv: Record<string, string>,
): NodeJS.ProcessEnv;
```

Behavior: start from `base`; delete every known provider var
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`); delete
every `RHUMB_*` var as today; then inject `credentialEnv`.

This preserves the existing blast-radius property — the spawned agent still cannot
read the scoped Proxmox token or the Postgres admin connection string, so it cannot
shell out past the operator-confirmation gate — and the existing comment explaining
that stays.

It also closes a hole present today: an ambient `ANTHROPIC_BASE_URL` in the host
environment currently passes straight through to the spawned agent, silently
redirecting all model traffic to an endpoint nobody configured. Under the allowlist
that is structurally impossible; the agent sees exactly the selected provider's
credentials and nothing else.

Single call site: `agent-host/src/index.ts:229`.

### 3. Call-site updates

- `index.ts:229` — `sanitizedEnv(process.env, config.provider.credentialEnv)`
- `index.ts:167`, `index.ts:199` — `config.provider.model`
- `index.ts:245` — startup log reports provider id alongside model, e.g.
  `rhumb agent-host listening on 127.0.0.1:8787 (provider gateway, model qwen3-coder)`.
  Never log credential values.

### 4. Installer (`scripts/install.sh`)

Prompt for provider first, defaulting to `subscription` and pre-seeded from the
existing `rhumb.env` on re-run (the installer is idempotent and must stay so). Then
branch to that mode's credential prompts and write only the relevant vars — a
gateway install must not leave a stale `CLAUDE_CODE_OAUTH_TOKEN=` line behind.

The `claude` CLI presence check (`install.sh:87`) becomes subscription-mode-only; it
is irrelevant noise in the other two modes.

`--dry-run` gains one assertion per mode, plus: gateway mode writes no
`CLAUDE_CODE_OAUTH_TOKEN`; an unknown provider value dies with a clear message;
re-running with an existing gateway `rhumb.env` produces a byte-identical file.

### 5. Documentation (accuracy pass)

- **`README.md`** — the "the personal-tool shape comes from Anthropic's terms"
  section is rewritten as a three-mode table. The compliance caveat is scoped to
  subscription mode rather than presented as a property of Rhumb.
- **`COMPLIANCE.md`** — restructured so "the core constraint" explicitly applies to
  subscription mode only. API-key and gateway modes are ordinary usage governed by
  the relevant provider's terms and carry no personal-tool restriction. The
  "if you want to go further" section is scoped the same way.
- **`docs/setup-manual.md`** — per-mode env examples, plus two honest caveats:
  1. Rhumb speaks the **Anthropic Messages API** via `@anthropic-ai/claude-agent-sdk`.
     OpenRouter and most local servers (ollama, vLLM) are OpenAI-compatible, so
     gateway mode requires an Anthropic-compatible endpoint in front — LiteLLM,
     claude-code-router, or equivalent. Rhumb does not translate protocols.
  2. Tool-calling fidelity is the practical limiter on open models. Rhumb's agent
     loop is tool-heavy; weaker models fail at tool use well before they fail at
     prose.
- **`SECURITY.md:45`** — the credential list gains the other provider vars.

### 6. Tests

- **New `agent-host/test/provider.test.ts`** — per mode: valid config; each missing
  required var; unknown provider value; unset defaults to `subscription`; gateway
  rejects a non-URL and a non-http scheme `ANTHROPIC_BASE_URL`; gateway rejects a
  missing `RHUMB_MODEL`; api-key and subscription apply the model default.
- **`agent-host/test/env.test.ts`** — extended for allowlist semantics: ambient
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are stripped
  when not selected; the selected `credentialEnv` is injected; `RHUMB_*` stripping
  is unchanged.
- **`agent-host/test/config.test.ts`** — updated for `provider` replacing
  `oauthToken` / `model`; existing tests that pass only `CLAUDE_CODE_OAUTH_TOKEN`
  must keep passing unchanged, which is the regression test for the default.
- **`scripts/install.sh --dry-run`** — assertions from §4.

## Risks

- **Live box regression.** Mitigated by the unset-means-subscription default and by
  the config tests that pass only `CLAUDE_CODE_OAUTH_TOKEN`. Verify on the box after
  redeploy before considering this done.
- **Gateway mode is only as good as the gateway.** Users will hit tool-calling
  failures on weak open models and read them as Rhumb bugs. Mitigated by the
  documented caveat; a health probe is out of scope here.
- **Installer branching.** Bash conditionals are where idempotency usually breaks;
  the byte-identical re-run assertion is the guard.

## Success criteria

1. `RHUMB_LLM_PROVIDER=api-key` with an `ANTHROPIC_API_KEY` boots and completes a
   real turn, with no OAuth token present anywhere in the environment.
2. `RHUMB_LLM_PROVIDER=gateway` against an Anthropic-compatible endpoint boots and
   completes a real turn.
3. An unchanged pre-existing `rhumb.env` (subscription, no `RHUMB_LLM_PROVIDER`)
   boots with identical behavior on the deployed box.
4. The spawned agent's environment contains exactly one provider's credentials and
   no `RHUMB_*` vars, verified by test.
5. `COMPLIANCE.md` no longer asserts a personal-tool restriction over deployments
   that do not use subscription auth.
