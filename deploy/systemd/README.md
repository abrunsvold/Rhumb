# Running the Rhumb hosts under systemd

The README's durability promise — surfaces that stay reachable at stable URLs —
only holds if the two hosts themselves survive crashes and reboots. These units
make that true. Without them, `npm start` dies with your shell.

## Install

```sh
# 1. Build both packages wherever the box keeps the checkout (example: /opt/rhumb)
cd /opt/rhumb/agent-host      && npm install && npm run build
cd /opt/rhumb/dashboard-host  && npm install && npm run build

# 2. Create the environment files (root-owned; they hold credentials)
sudo mkdir -p /etc/rhumb
sudo cp /opt/rhumb/.env.example /etc/rhumb/agent-host.env    # then edit
sudo touch /etc/rhumb/dashboard-host.env                     # then edit
sudo chmod 600 /etc/rhumb/*.env

# 3. Install and adjust the units
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/rhumb-agent-host.service     # User=, WorkingDirectory=
sudo $EDITOR /etc/systemd/system/rhumb-dashboard-host.service

# 4. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now rhumb-agent-host rhumb-dashboard-host
```

## What to set where

| Setting | agent-host.env | dashboard-host.env |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅ required | — |
| `RHUMB_ALLOWED_USERS` | ✅ required | ✅ required |
| `RHUMB_WORKSPACE` | optional (default `./workspace`) | ✅ must point at the agent host's workspace |
| `RHUMB_PROXMOX_*`, `RHUMB_PG_ADMIN`, `RHUMB_LXC_*`, `RHUMB_DEPLOY_KEY` | optional (enables infra/services) | — |

See [.env.example](../../.env.example) for the full list.

Two decisions the unit files force you to make, on purpose:

- **`User=`** — the agent host must run as the user whose `~/.claude` holds the
  Claude Code login state and session transcripts; a `nologin` system account
  breaks the transcript API. The dashboard host must be able to read the same
  workspace; running both as one user is the simple correct answer.
- **`EnvironmentFile=`** — every credential stays in `/etc/rhumb/*.env`
  (root-owned, mode 600), never in the unit file itself, which lands in the
  world-readable `/etc/systemd/system`.

## Checking on it

```sh
systemctl status rhumb-agent-host rhumb-dashboard-host
journalctl -u rhumb-agent-host -f
```

`tailscale serve` state persists on its own (`scripts/setup-serve.sh` is
one-time), so after a reboot the full path — tailnet → serve → hosts →
surfaces — comes back without a login.
