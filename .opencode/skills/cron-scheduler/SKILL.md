---
name: cron-scheduler
description: AI cron/scheduler skill based on Cronicle — create, manage, and monitor scheduled jobs. Supports cron expressions, interval scheduling, one-time runs, opencode session callbacks, and distributed worker execution. Use when the user mentions scheduling, cron jobs, timed tasks, periodic execution, or agent wake-up.
---

# cron-scheduler

Distributed cron/scheduler for AI agents, backed by [Cronicle](https://github.com/jhuckaby/Cronicle).

Two scripts, two audiences:

| Script | Audience | Capabilities |
|--------|----------|-------------|
| **`cron-agent.sh`** | AI agents | Job CRUD, run-now, query history, health check. No service management. |
| **`cron-cli.sh`** | Humans / admin | Full access: everything above + start/stop, install-cmd, clear |

**Agents use `cron-agent`**. Humans use `cron-cli`.

## Behavior Rules

### 1. Validate Before Creating

Always validate JobSpec before calling `create`:
- Cron expressions must be valid 5-field format
- Runner must be in the whitelist (`runners.conf`)
- Required fields: `name`, `schedule`, `execution.runner`

### 2. Use Callbacks for Agent Wake-up

To schedule an agent to wake up on a timer:

```bash
cron-agent callback \
  --session ses_abc123 \
  --schedule "0 9 * * *" \
  --prompt "Generate daily report"
```

This creates a job that runs `opencode run -s ses_abc123 -p "Generate daily report"` on schedule.

### 3. Secret Injection

All sensitive values are injected via `config-cli`:

```bash
config-cli set CRONICLE_API_KEY <key>
```

The scripts auto-detect and load from the vault.

### 4. Runner Whitelist

Only whitelisted runners can be used in jobs. Default whitelist:
- `opencode` — for session callbacks
- `/usr/local/bin/job_runner` — generic runner
- `/usr/local/bin/opencode` — explicit path

Custom runners: add to `.opencode/skills/cron-scheduler/runners.conf`

### 5. Schedule Types

| Type | Format | Example |
|------|--------|---------|
| `cron` | Standard 5-field cron | `"0 9 * * 1-5"` (weekdays 9am) |
| `every` | Interval duration | `"30m"`, `"2h"`, `"1d"` |
| `once` | ISO 8601 datetime | `"2025-06-15T09:00:00"` |

## Prerequisites

1. **Docker** with Compose V2
2. **curl** and **jq** for API calls
3. **config-cli** (optional, for secret management)

Install:
```bash
bash .opencode/skills/cron-scheduler/scripts/install.sh
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
| `cron-agent callback [flags]` | Create opencode callback job |

## Admin Commands (`cron-cli`)

All agent commands above, plus:

| Command | Description |
|---------|-------------|
| `cron-cli start` | Start Cronicle server (Docker) |
| `cron-cli stop` | Stop Cronicle server |
| `cron-cli status` | Show service status |
| `cron-cli install-cmd [flags]` | Generate worker install command |
| `cron-cli clear --confirm` | Delete ALL jobs |

## JobSpec Format

AI agents use this JSON format to create jobs:

```json
{
  "name": "daily_report",
  "enabled": true,
  "schedule": {
    "type": "cron",
    "expr": "0 9 * * *",
    "timezone": "America/Los_Angeles"
  },
  "target": {
    "hostname": "worker-1"
  },
  "execution": {
    "runner": "opencode",
    "args": ["run", "-s", "ses_abc123", "-p", "Generate report"]
  },
  "policy": {
    "timeout_sec": 900,
    "retries": 2
  }
}
```

### JobSpec Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Job display name (unique) |
| `enabled` | No | Active state (default: true) |
| `schedule.type` | Yes | `cron`, `every`, or `once` |
| `schedule.expr` | Yes | Schedule expression |
| `schedule.timezone` | No | IANA timezone (default: UTC) |
| `target.hostname` | No | Specific worker hostname |
| `execution.runner` | Yes | Runner binary path (must be whitelisted) |
| `execution.args` | No | Arguments array |
| `policy.timeout_sec` | No | Max execution time in seconds |
| `policy.retries` | No | Retry count on failure |

## Workflow Examples

### Agent: Create and Monitor a Job

```bash
# Create a cron job
cron-agent create '{
  "name": "cleanup_logs",
  "enabled": true,
  "schedule": {"type": "cron", "expr": "0 2 * * *"},
  "execution": {"runner": "/usr/local/bin/job_runner", "args": ["--task", "cleanup"]},
  "policy": {"timeout_sec": 300}
}'

# List all jobs
cron-agent list

# Check execution history
cron-agent history <event_id>

# Trigger manually
cron-agent run <event_id>

# Check running jobs
cron-agent active
```

### Agent: Schedule Self Wake-up

```bash
# Wake this agent every morning at 9am
cron-agent callback \
  --session ses_my_session \
  --schedule "0 9 * * *" \
  --prompt "Check overnight alerts and summarize"
```

### Agent: Schedule Another Agent

```bash
# Create a new agent session, get session ID
# Then schedule periodic wake-up
cron-agent callback \
  --session ses_other_agent \
  --schedule "*/30 * * * *" \
  --prompt "Poll API for new data and process"
```

### Admin: Full Lifecycle

```bash
# Install the skill
bash .opencode/skills/cron-scheduler/scripts/install.sh

# Store API key
config-cli set CRONICLE_API_KEY $(openssl rand -hex 16)

# Start server
cron-cli start

# Check status
cron-cli status

# Generate worker install command
cron-cli install-cmd --server-url http://master:3012 --tags ops

# Stop server
cron-cli stop
```

## Architecture

```
AI Agent ──→ cron-agent.sh ──→ Cronicle REST API ──→ Cronicle Master
                                                         │
                                                    ┌────┴────┐
                                                    ▼         ▼
                                               Worker 1   Worker N
                                               (execute)  (execute)
                                                    │         │
                                                    ▼         ▼
                                               Results → Cronicle → Web UI
```

- **Cronicle Master**: Docker container, port 3012, SQLite-like filesystem storage
- **Workers**: Cronicle worker nodes on any host machine
- **Web UI**: Built-in at `http://localhost:3012` — jobs, executions, logs, workers
- **API Auth**: API key via `X-API-Key` header
- **Storage**: Docker volume `cronicle_data` for persistence

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CRONICLE_URL` | Server URL | `http://localhost:3012` |
| `CRONICLE_API_KEY` | API key for auth | (from config-cli vault) |
| `CRONICLE_PORT` | Web UI / API port | `3012` |
| `CRONICLE_SECRET` | Multi-server shared secret | (auto-generated) |
| `CRON_RUNNER_WHITELIST` | Path to runners.conf | (skill default) |

## Worker Installation

Install a Cronicle worker on a remote machine:

```bash
bash install-worker.sh \
  --server http://master:3012 \
  --secret <shared_secret> \
  --tags ops,linux
```

The script:
1. Installs Node.js if needed
2. Downloads and builds Cronicle
3. Configures as worker with the master's secret key
4. Creates a systemd service
5. Starts and verifies connection

## Monitoring

Cronicle's built-in Web UI provides:
- Job list with schedules and status
- Execution history with logs
- Real-time job progress
- Worker status (online/offline)
- Success rate statistics

Access at: `http://localhost:3012` (default admin: `admin`/`admin`)
