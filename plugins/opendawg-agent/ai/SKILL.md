---
name: opendawg-agent
description: Spawn and manage fully-configured opencode CLI sessions. Use when the user wants to launch opencode on a local or remote machine, bootstrap environments with skills from a git repo, set up config-cli auth and vault secrets, or orchestrate opencode agents. Also triggers when the user mentions opendawg-agent, spawning agents, remote opencode, or multi-machine orchestration.
---

# opendawg-agent

Two scripts, two concerns:

| Script | Purpose | When to run |
|--------|---------|-------------|
| **`setup.sh`** | Environment prep — sync skills, config-cli auth, vault secrets, install/update opencode | Once per machine/project, or when environment changes |
| **`opendawg-agent.sh`** | Launch opencode for a task — lightweight, no network calls, no updates | Every task invocation |

**Always run `setup.sh` first**, then use `opendawg-agent.sh` for all interactions.

## Execution Method Priority

| Priority | Method | When to use |
|----------|--------|-------------|
| **1. opencode serve (HTTP API)** | `opencode serve` on target, interact via REST API / `@opencode-ai/sdk` | Network available, opencode server deployed. Best for automation — structured API, no SSH needed. |
| **2. SSH / other tools + opencode CLI** | `ssh host "cd /project && bash .../opendawg-agent.sh ..."` | No opencode server, but SSH available. Direct CLI execution on remote machine. |
| **3. tmux-tty + opencode CLI** | `tmux-wrapper.sh` + `opendawg-agent.sh` | No network / no SSH. Need TTY persistence, multi-turn interaction, or network resilience (tmux survives disconnects). |

**opencode serve is preferred** — pure HTTP, full session management, no SSH overhead. Fall back to SSH+CLI when no server is deployed, and to tmux-tty only when network is unreliable or unavailable.

### opencode serve quick reference

Start server on target: `opencode serve` (default port 4096). Key REST endpoints:

```bash
SERVER="http://localhost:4096"

# Create session
curl -s -X POST "$SERVER/session" -H "Content-Type: application/json" -d '{"title":"my-task"}'

# Send prompt (async, returns immediately)
curl -s -X POST "$SERVER/session/$SID/prompt_async" \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"/opendawg implement auth"}]}'

# Stream events (SSE) — watch for session.idle (done), message.part.updated (output)
curl -N "$SERVER/event"

# Get messages
curl -s "$SERVER/session/$SID/message?limit=20"

# Abort session
curl -s -X POST "$SERVER/session/$SID/abort"
```

Optional Basic Auth: set `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`, add `-H "Authorization: Basic $(echo -n user:pass | base64)"`.

## CLI vs TUI Mode

`opendawg-agent.sh` defaults to **CLI mode** (`opencode run`):

- **New session** (no `-s`): uses `--format json` automatically to capture the session ID, prints `[opendawg-agent] session=<id>`
- **Continue session** (with `-s <id>`): runs `opencode run` normally — no `--format json`

Use `--tui` only when the user explicitly requests interactive exploration.

| Scenario | What happens |
|----------|-------------|
| **New session** | `opencode run --format json` → JSON output + session ID |
| **Continue session** | `opencode run -s <id>` → normal output |
| **TUI** | `opencode --tui` → interactive terminal UI |

## Best Practice: Use `/opendawg` Slash Command

**Prefer `/opendawg [task]` over raw prompts** whenever the project has opendawg skills installed (`.opencode/commands/opendawg.md` exists). The `/opendawg` command provides structured triage, tool preference enforcement, memory management, and sub-agent delegation.

| Prompt style | When to use |
|--------------|-------------|
| `/opendawg implement the login feature` | **Default** — project has opendawg skills |
| `"implement the login feature"` | Fallback — project lacks opendawg skills, or task needs no orchestration |

## Best Practice: Session Tracking with `-s`

**ALWAYS use `-s <session-id>` for session continuity.** Never rely on `-c` — it is ambiguous with parallel agents.

The session ID is captured on the **first run only**:

```
1st run:  opendawg-agent.sh "/opendawg build the auth module"
          → JSON output (--format json, automatic)
          → [opendawg-agent] session=ses_abc123

2nd run:  opendawg-agent.sh -s ses_abc123 "/opendawg add rate limiting"
          → normal output

3rd run:  opendawg-agent.sh -s ses_abc123 "/opendawg write tests"
          → normal output
```

Extract session ID from captured output:
```bash
grep -o 'session=ses_[^ ]*' <<< "$CAPTURED_OUTPUT" | tail -1 | cut -d= -f2
```

## Workflow (CLI Mode — Recommended)

### 1. Setup (once)

```bash
bash <skill-path>/scripts/setup.sh \
  --repo https://github.com/VincentHanxiaoDu/opendawg \
  --config-cli-endpoint "https://..."
```

### 2. First task (new session)

```bash
bash <skill-path>/scripts/opendawg-agent.sh "/opendawg implement the login feature"
# → [opendawg-agent] session=ses_abc123
```

### 3. Continue the session

```bash
bash <skill-path>/scripts/opendawg-agent.sh -s ses_abc123 "/opendawg add unit tests"
```

### Via tmux (when TTY needed)

```bash
<tmux-skill-path>/tmux-wrapper.sh start oc bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'cd /path/to/project' Enter

# Setup (once)
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/setup.sh \
  --repo https://github.com/VincentHanxiaoDu/opendawg' Enter

# First task
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opendawg-agent.sh \
  "/opendawg implement the login feature"' Enter

# Capture session ID
sleep 30
OUTPUT=$(<tmux-skill-path>/tmux-wrapper.sh capture oc)
SID=$(echo "$OUTPUT" | grep -o 'session=ses_[^ ]*' | tail -1 | cut -d= -f2)

# Continue
<tmux-skill-path>/tmux-wrapper.sh send oc "bash <skill-path>/scripts/opendawg-agent.sh \
  -s $SID \"/opendawg add unit tests\"" Enter

# Cleanup
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

## Workflow (TUI Mode)

### Launch

```bash
bash <skill-path>/scripts/setup.sh --repo https://github.com/VincentHanxiaoDu/opendawg
bash <skill-path>/scripts/opendawg-agent.sh --tui
```

### Interact

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc '/opendawg implement the login feature' Enter
sleep 0.5
<tmux-skill-path>/tmux-wrapper.sh send oc Enter
```

### Quit TUI

Send `C-c` — the process terminates and tmux session auto-destroys:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc C-c
```

If the session lingers, force-kill:

```bash
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

### Authenticate (if needed)

Exit TUI first (`C-c`), then:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'opencode auth login' Enter
sleep 2
<tmux-skill-path>/tmux-wrapper.sh capture oc
```

## Script Arguments

### setup.sh

```bash
bash <skill-path>/scripts/setup.sh [options]
```

| Flag | Arg | Purpose |
|------|-----|---------|
| `--repo` | `<url>` | Git repo with `.opencode/skills/` (required first run) |
| `--repo-branch` | `<branch>` | Branch to use (default: main) |
| `--config-cli-endpoint` | `<url>` | config-cli login endpoint |
| `--config-cli-token` | `<token>` | config-cli token (alternative to endpoint) |
| `--graphiti-group-id` | `<id>` | Override GRAPHITI_GROUP_ID (default: opendawg) |
| `--graphiti-model` | `<model>` | Override MODEL_NAME for graphiti |

### opendawg-agent.sh

```bash
bash <skill-path>/scripts/opendawg-agent.sh [options] [prompt...]
```

| Flag | Arg | Purpose |
|------|-----|---------|
| `-s, --session` | `<id>` | Continue specific session (**preferred**) |
| `-c, --continue` | - | Continue the last session (unsafe with parallel agents) |
| `--tui` | - | Launch interactive TUI |
| `--log-level` | `<level>` | Log level (default: DEBUG) |

All unrecognized flags pass through to opencode.

## Environment Variables

`setup.sh` injects these from config-cli vault:

| Variable | Source | Notes |
|----------|--------|-------|
| `AZURE_OPENAI_API_KEY` | config-cli vault | Required for graphiti |
| `AZURE_OPENAI_ENDPOINT` | config-cli vault | Azure OpenAI endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | vault or `--graphiti-model` | LLM deployment name |
| `NEO4J_PASSWORD` | config-cli vault | Optional, for Neo4j |
| `GRAPHITI_GROUP_ID` | `--graphiti-group-id` or default | Default: opendawg |

## Cron Scheduling Integration

`setup.sh` includes a Step 6 that auto-installs a Cronicle worker if `CRONICLE_URL` and `CRONICLE_SECRET` are present in the config-cli vault. This gives spawned agents automatic cron scheduling capability via the `cron-scheduler` skill — no manual worker setup required.

- The worker registers with the Cronicle server and can receive scheduled jobs
- Uses `cron-client install` under the hood (from the cron-scheduler skill)
- Skipped silently if vault lacks `CRONICLE_URL` or `CRONICLE_SECRET`
- Idempotent: safe to run multiple times

## Prerequisites

- **git** — for cloning the skills repo
- **tmux** — for TTY session management (via tmux-tty skill)
- **brew** — for installing/updating opencode (macOS)
- **rsync** — for incremental skills merge

## Pitfalls

- **Run `setup.sh` before `opendawg-agent.sh`** — the agent script assumes opencode is installed and env is ready
- **Always use `-s <id>`, never `-c` for automation** — `-c` picks "last session" globally, breaks with parallel agents
- **Prefer CLI mode for automation** — structured output, no TUI artifacts
- **Always `sleep` after `send`** before `capture` — let commands initialize
- **Always `stop` tmux sessions** when done — prevents orphaned sockets
- **Secrets go through config-cli** — never pass secrets as plain arguments
- **TUI exit** — send `C-c`; do NOT use `/exit` (triggers slash-command palette fuzzy match)
- **TUI prompt submission** — text typed via `send` lands in input field; needs an extra `Enter` to submit
