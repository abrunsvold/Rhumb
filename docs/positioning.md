# Rhumb — positioning & use cases

> Who Rhumb is for, what you'd build with it, and how it compares. Companion to the [README](../README.md); the README covers *what it is and how it's built*, this covers *who it's for and what to make*.

## The one-liner

**Rhumb is a homelab-native internal-tools builder.** Describe the tool you need — a 3D-printer tracker, a runbook wiki, a status board — and a Claude agent builds it, provisions its backend, and keeps it running on your own hardware. No app to code, no SaaS to trust, no data leaving your box.

## Who it's for

People who **already self-host**. You've got a Proxmox node in a closet and a dozen little jobs that deserve a real tool but never get one — because building an app for "track which printer has filament" isn't worth an afternoon.

That's the wedge. Rhumb is **not** trying to be a zero-setup tool for everyone: it runs on your own Proxmox, over Tailscale, on your own Claude subscription, and it's [early and not yet production-hardened](../README.md). The on-ramp is homelab-grade — but that audience *tolerates* setup (they run Proxmox for fun) and is genuinely underserved. Retool-the-SaaS isn't self-hosted-first; Budibase / Appsmith still make you build the tool by hand.

So the honest framing is: **fast internal tools for people who already have a homelab** — not "fast internal tools for anyone." The setup cost is a Tuesday; the payoff is every small tool you never got around to.

## What makes it different

The natural comparison isn't the AI app-builders (v0, bolt, Lovable) — those are cloud SaaS that hand you a file, not a running system on hardware you own. It's the **internal-tools platforms**: Retool, Budibase, Appsmith, Tooljet, NocoDB.

The distinction, in one line:

> **You don't build the tool — you describe it, and an agent builds *and hosts* it, on your own box, with its own backend.**

Retool makes *you* wire a UI to a data source you already have. Rhumb has the agent **stand up the database or service *and* the UI *and* register them together** — then leaves it running at a stable tailnet URL, isolated in its own container, behind an operator confirmation for anything destructive. None of the internal-tools platforms do the provisioning half, and none are self-hosted-first on your own hypervisor.

## What you'd build (each exercises a different subsystem)

| Tool | What it exercises |
|------|-------------------|
| **3D-printer tracker** — printers, jobs, filament levels; polls OctoPrint/Klipper | spawned service (poller) → provisioned DB → surface → ontology (printers↔jobs) — the whole stack in one build |
| **Homelab status board** — VMs / containers / services, up-down at a glance | reads infrastructure (`list_vms`) + live-data surface + the ontology as the map of your box |
| **Runbook / docs wiki** — internal notes, procedures, wikilinks | file surfaces + the Obsidian-browsable vault; no backend needed |
| **Household / lab inventory** — CRUD with confirmed writes | agent-provisioned Postgres + write-back through the confirmation gate + persisted trust |
| **API ingest service** — pulls a feed on a schedule into a DB | container-isolated spawned service + provisioning, survives host reboot (systemd unit, `onboot` container) |
| **Sensor / energy dashboard** — time-series from your box or Home Assistant | live-data endpoint + a charting surface |
| **Side-project ticket board** — issues, statuses, assignees | provisioned DB + a CRUD surface, no Jira |
| **"What's running on my box" graph** — browse the environment itself | the ontology *as the product* — query it, or open the graph in Obsidian |

Each one maps to a subsystem Rhumb already has — so this list doubles as proof the architecture actually serves the persona, not just a wish-list.

## Taglines (candidates)

- *Describe the tool. Own the stack.*
- *Internal tools for your homelab, built by an agent.*
- *Your closet server, now with a builder.*

## The honest caveats

- **Self-hosting posture is deliberate, not incidental** — Rhumb is a personal tool by design (your hardware, your credentials; it doesn't broker Claude login). See the README's personal-tool note and [COMPLIANCE.md](../COMPLIANCE.md).
- **Early software.** The subsystems work and are tested, but this isn't a turnkey product yet; expect to get your hands dirty.
- **Real infrastructure means real blast radius** — which is why every destructive/provisioning action is gated behind an operator confirmation, scoped to a least-privilege Proxmox token, and audited. See [SECURITY.md](../SECURITY.md).
