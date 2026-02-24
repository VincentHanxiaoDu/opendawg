---
name: cron-scheduler
description: AI cron/scheduler skill based on Cronicle — create, manage, and monitor scheduled jobs. Supports cron expressions, interval scheduling, one-time runs, opencode session callbacks, and distributed worker execution. Use when the user mentions scheduling, cron jobs, timed tasks, periodic execution, or agent wake-up.
---

# cron-scheduler

Distributed cron/scheduler for AI agents, backed by [Cronicle](https://github.com/jhuckaby/Cronicle).

**Host-native architecture**: Cronicle runs as a systemd service on the host (not Docker). The master server handles both scheduling and local job execution. Remote workers can be added via `cron-client install`.

Three scripts, three roles:

| Script | Audience | Capabilities |
|--------|----------|-------------|
| **`cron-agent.sh`** | AI agents | Job CRUD, run-now, query history, callback. No service management. |
| **`cron-cli.sh`** | Humans / admin | Full access: everything above + start/stop server, clear |
| **`cron-client.sh`** | Host setup | Install/status/uninstall Cronicle worker on host |

**Agents use `cron-agent`**. Humans use `cron-cli`. Workers are managed via `cron-client`.

## Behavior Rules

### 1. Validate Before Creating

Always validate JobSpec before calling `create`:
- Cron expressions must be valid 5-field format
- Runner must be in the whitelist (`runners.conf`)
- Required fields: `name`, `schedule`, `execution.runner`

### 2. Use Callbacks for Agent Wake-up

To schedule periodic delivery of a prompt or script output into an existing opencode session:

```bash
# Script mode: run shell command, deliver output to session (recommended for data collection)
cron-agent callback \
  --session ses_abc123 \
  --schedule "*/10 * * * *" \
  --script "uptime && free -h && df -h /"

# Direct prompt mode: inject a prompt into the session
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 9 * * *" \
  --prompt "Generate daily report"

# Isolated agent mode: run prompt in new session, deliver result to callback session
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 8 * * 1" \
  --prompt "Fetch weekly metrics from API and summarize" \
  --isolated
```

**Delivery mechanism**: Phase 2 injects the result into the callback session via the opencode HTTP API (`POST /session/{id}/prompt_async`, returns 204). This avoids the `opencode run -s` CLI which can fail with *"This model does not support assistant message prefill"* when the session's last message is already an assistant reply.

If the opencode server requires Basic Auth, set `--auth user:password` or store `OPENCODE_AUTH` in the config-cli vault.

### 3. Server Config Auto-Discovery

Server config (`CRONICLE_URL`, `CRONICLE_API_KEY`, `CRONICLE_SECRET`) is automatically:
- **Written to vault** by `cron-cli start` after server startup
- **Read from vault** by `cron-agent`, `cron-client`, and `setup.sh`

No manual env var configuration needed when using config-cli vault.

### 4. Runner Whitelist

Only whitelisted runners can be used in jobs. Default whitelist:
- `bash` / `/bin/bash` / `/bin/sh` — for shell scripts (used by callback jobs)
- `curl` — for HTTP-based triggers

Custom runners: add to `.opencode/skills/cron-scheduler/runners.conf`

### 5. Schedule Types

| Type | Format | Example |
|------|--------|---------|
| `cron` | Standard 5-field cron | `"0 9 * * 1-5"` (weekdays 9am) |
| `every` | Interval duration | `"30m"`, `"2h"`, `"1d"` |
| `once` | ISO 8601 datetime | `"2025-06-15T09:00:00"` |

## Prerequisites

1. **Node.js** 18+ (for Cronicle)
2. **curl** and **jq** for API calls
3. **config-cli** (optional, for secret management and auto-discovery)
4. **systemd** (for service management; optional, can run manually)

Install:
```bash
bash .opencode/skills/cron-scheduler/scripts/install.sh
```

## Quick Start

```bash
# 1. Install the skill
bash .opencode/skills/cron-scheduler/scripts/install.sh

# 2. Start the master server (auto-writes config to vault)
cron-cli start

# 3. Schedule a callback — delivers output to session every 10 minutes
cron-agent callback \
  --session ses_abc123 \
  --schedule "*/10 * * * *" \
  --script "uptime && free -h && df -h /"

# 4. (Optional) Add a remote worker
# On the remote host: cron-client install
```

## Agent Commands (`cron-agent`)

| Command | Description |
|---------|-------------|
| `cron-agent create <json>` | Create a job from JobSpec JSON |
| `cron-agent update <id> <json>` | Update a job (partial) |
| `cron-agent delete <id>` | Delete a job |
| `cron-agent enable <id>` | Enable a job |
| `cron-agent disable <id>` | Disable a job |
| `cron-agent run <id>` | Trigger immediate execution |
| `cron-agent list [--limit N]` | List all jobs |
| `cron-agent get <id-or-title>` | Get job details |
| `cron-agent history <id> [--limit N]` | Execution history for a job |
| `cron-agent execution <id>` | Get execution details |
| `cron-agent active` | List currently running jobs |
| `cron-agent health` | Server health check |
| `cron-agent callback [flags]` | Create session callback job — delivers script output or prompt to session via HTTP API |

## Admin Commands (`cron-cli`)

All agent commands above, plus:

| Command | Description |
|---------|-------------|
| `cron-cli start` | Start Cronicle master (host systemd), write config to vault |
| `cron-cli stop` | Stop Cronicle server |
| `cron-cli status` | Show service status |
| `cron-cli install-cmd [flags]` | Generate worker install command |
| `cron-cli clear --confirm` | Delete ALL jobs |

## Client Commands (`cron-client`)

| Command | Description |
|---------|-------------|
| `cron-client install [--server-url <url>] [--secret <key>]` | Install Cronicle worker on host |
| `cron-client status` | Show worker status and connection info |
| `cron-client uninstall [--purge]` | Stop and remove worker |

## Architecture

```
┌──────────────────────────┐
│  Primary Host            │
│  Cronicle Master         │        ┌──────────────────────┐
│  (systemd service)       │        │  Host B (remote)     │
│  - Scheduling + local    │◄──────►│  Cronicle Worker     │
│    job execution         │  TCP   │  executes:           │
│  - REST API on :3012     │        │  opendawg-agent.sh   │
│  - Web UI                │        └──────────────────────┘
│  - opendawg-agent.sh     │               ▲
│    runs directly on host │               │ same flow
└──────────────────────────┘               ▼
                                   ┌──────────────────────┐
                                   │  Host C (remote)     │
                                   │  Cronicle Worker     │
                                   │  opendawg-agent.sh   │
                                   └──────────────────────┘
```

- **Cronicle Master**: Host-native systemd service (not Docker), port 3012
- **Local execution**: Master runs jobs locally on the primary host (no separate worker needed)
- **Remote workers**: Installed on other machines via `cron-client install`
- **Execution**: Jobs invoke `opendawg-agent.sh` with full host environment
- **Config**: Server config auto-propagated via config-cli vault
- **Web UI**: Built-in at `http://localhost:3012`

## Config Propagation Flow

```
cron-cli start
  → writes CRONICLE_URL, CRONICLE_API_KEY, CRONICLE_SECRET to vault

setup.sh (on any host)
  → reads vault → auto-installs cron worker → worker connects to server

cron-agent callback
  → reads vault for API key → creates job targeting host worker
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CRONICLE_URL` | Server URL (auto from vault) | `http://localhost:3012` |
| `CRONICLE_API_KEY` | API key for auth (auto from vault) | (from config-cli vault) |
| `CRONICLE_PORT` | Web UI / API port | `3012` |
| `CRONICLE_SECRET` | Multi-server shared secret (auto from vault) | (auto-generated) |
| `CRON_RUNNER_WHITELIST` | Path to runners.conf | (skill default) |
| `OPENCODE_SERVER_URL` | opencode server URL for session callbacks | `http://localhost:4096` |
| `OPENCODE_AUTH` | Basic Auth for opencode server (`user:password`) | (from config-cli vault) |

`OPENCODE_SERVER_URL` and `OPENCODE_AUTH` are auto-read from config-cli vault (keys: `OPENCODE_SERVER_URL`, `OPENCODE_AUTH`) if not set in environment.

## Callback Details

The `callback` command creates a Cronicle job with a two-phase bash script:

**Phase 1** — Execute task:
- `--script "cmd"`: runs the shell command, captures stdout+stderr
- `--prompt "text" --isolated`: runs `opendawg-agent.sh "<prompt>"` in a **new** session, captures output
- `--prompt "text"`: skips Phase 1; the prompt itself is the delivery message

**Phase 2** — Deliver to session:
- Injects the result (or prompt) into the callback session via **opencode HTTP API**:
  ```
  POST {OPENCODE_SERVER_URL}/session/{sessionID}/prompt_async
  Body: {"parts":[{"type":"text","text":"<delivery_message>"}]}
  Returns: 204 No Content
  ```
- **Does NOT use `opencode run -s`** — avoids the assistant-message-prefill error that occurs when the session's conversation already ends with an assistant reply

```bash
# Script mode (recommended for data/monitoring tasks)
cron-agent callback \
  --session ses_abc123 \
  --schedule "*/10 * * * *" \
  --script "uptime && free -h"

# Direct prompt mode
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 9 * * *" \
  --prompt "Generate daily report"

# Isolated agent mode (for tasks needing full agent capability)
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 8 * * 1" \
  --prompt "Fetch and analyze weekly metrics" \
  --isolated

# With auth (when opencode server has Basic Auth enabled)
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 * * * *" \
  --script "df -h /" \
  --server-url "http://192.168.1.100:4096" \
  --auth "user:password"

# Target a specific host worker
cron-agent callback \
  --session ses_abc123 \
  --schedule "*/30 * * * *" \
  --host worker-2 \
  --script "check-service.sh"
```

## Monitoring

Cronicle's built-in Web UI provides:
- Job list with schedules and status
- Execution history with logs
- Real-time job progress
- Worker status (online/offline)
- Success rate statistics

Access at: `http://localhost:3012` (default admin: `admin`/`admin`)
