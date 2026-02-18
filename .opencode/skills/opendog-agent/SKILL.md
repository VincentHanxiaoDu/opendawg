---
name: opendog-agent
description: Spawn and manage fully-configured opencode CLI sessions. Use when the user wants to launch opencode on a local or remote machine, bootstrap environments with skills from a git repo, set up config-cli auth and vault secrets, or orchestrate opencode agents. Also triggers when the user mentions opendog-agent, spawning agents, remote opencode, or multi-machine orchestration.
---

# opendog-agent

Two scripts, two concerns:

| Script | Purpose | When to run |
|--------|---------|-------------|
| **`setup.sh`** | Environment prep — sync skills, config-cli auth, vault secrets, install/update opencode | Once per machine/project, or when environment changes |
| **`opendog-agent.sh`** | Launch opencode for a task — lightweight, no network calls, no updates | Every task invocation |

**Always run `setup.sh` first**, then use `opendog-agent.sh` for all interactions.

## Execution Method Priority

| Priority | Method | When to use |
|----------|--------|-------------|
| **1. SSH direct** | `ssh host "cd /project && bash .../opendog-agent.sh ..."` | SSH available, simple/single-turn tasks, good network |
| **2. tmux-tty** | `tmux-wrapper.sh` + `opendog-agent.sh` | No reliable SSH, need TTY, multi-turn interaction, or poor network (tmux survives disconnects) |

**SSH is preferred** for straightforward invocations — no tmux overhead, direct stdout capture. Fall back to tmux for persistent sessions, TTY interaction, or network resilience.

## CLI vs TUI Mode

`opendog-agent.sh` defaults to **CLI mode** (`opencode run`):

- **New session** (no `-s`): uses `--format json` automatically to capture the session ID, prints `[opendog-agent] session=<id>`
- **Continue session** (with `-s <id>`): runs `opencode run` normally — no `--format json`

Use `--tui` only when the user explicitly requests interactive exploration.

| Scenario | What happens |
|----------|-------------|
| **New session** | `opencode run --format json` → JSON output + session ID |
| **Continue session** | `opencode run -s <id>` → normal output |
| **TUI** | `opencode --tui` → interactive terminal UI |

## Best Practice: Use `/opendog` Slash Command

**Prefer `/opendog [task]` over raw prompts** whenever the project has opendog skills installed (`.opencode/commands/opendog.md` exists). The `/opendog` command provides structured triage, tool preference enforcement, memory management, and sub-agent delegation.

| Prompt style | When to use |
|--------------|-------------|
| `/opendog implement the login feature` | **Default** — project has opendog skills |
| `"implement the login feature"` | Fallback — project lacks opendog skills, or task needs no orchestration |

## Best Practice: Session Tracking with `-s`

**ALWAYS use `-s <session-id>` for session continuity.** Never rely on `-c` — it is ambiguous with parallel agents.

The session ID is captured on the **first run only**:

```
1st run:  opendog-agent.sh "/opendog build the auth module"
          → JSON output (--format json, automatic)
          → [opendog-agent] session=ses_abc123

2nd run:  opendog-agent.sh -s ses_abc123 "/opendog add rate limiting"
          → normal output

3rd run:  opendog-agent.sh -s ses_abc123 "/opendog write tests"
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
  --repo https://github.com/VincentHanxiaoDu/opendog \
  --config-cli-endpoint "https://..."
```

### 2. First task (new session)

```bash
bash <skill-path>/scripts/opendog-agent.sh "/opendog implement the login feature"
# → [opendog-agent] session=ses_abc123
```

### 3. Continue the session

```bash
bash <skill-path>/scripts/opendog-agent.sh -s ses_abc123 "/opendog add unit tests"
```

### Via tmux (when TTY needed)

```bash
<tmux-skill-path>/tmux-wrapper.sh start oc bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'cd /path/to/project' Enter

# Setup (once)
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/setup.sh \
  --repo https://github.com/VincentHanxiaoDu/opendog' Enter

# First task
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opendog-agent.sh \
  "/opendog implement the login feature"' Enter

# Capture session ID
sleep 30
OUTPUT=$(<tmux-skill-path>/tmux-wrapper.sh capture oc)
SID=$(echo "$OUTPUT" | grep -o 'session=ses_[^ ]*' | tail -1 | cut -d= -f2)

# Continue
<tmux-skill-path>/tmux-wrapper.sh send oc "bash <skill-path>/scripts/opendog-agent.sh \
  -s $SID \"/opendog add unit tests\"" Enter

# Cleanup
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

## Workflow (TUI Mode)

### Launch

```bash
bash <skill-path>/scripts/setup.sh --repo https://github.com/VincentHanxiaoDu/opendog
bash <skill-path>/scripts/opendog-agent.sh --tui
```

### Interact

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc '/opendog implement the login feature' Enter
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
| `--graphiti-group-id` | `<id>` | Override GRAPHITI_GROUP_ID (default: opendog) |
| `--graphiti-model` | `<model>` | Override MODEL_NAME for graphiti |

### opendog-agent.sh

```bash
bash <skill-path>/scripts/opendog-agent.sh [options] [prompt...]
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
| `GRAPHITI_GROUP_ID` | `--graphiti-group-id` or default | Default: opendog |

## Prerequisites

- **git** — for cloning the skills repo
- **tmux** — for TTY session management (via tmux-tty skill)
- **brew** — for installing/updating opencode (macOS)
- **rsync** — for incremental skills merge

## Pitfalls

- **Run `setup.sh` before `opendog-agent.sh`** — the agent script assumes opencode is installed and env is ready
- **Always use `-s <id>`, never `-c` for automation** — `-c` picks "last session" globally, breaks with parallel agents
- **Prefer CLI mode for automation** — structured output, no TUI artifacts
- **Always `sleep` after `send`** before `capture` — let commands initialize
- **Always `stop` tmux sessions** when done — prevents orphaned sockets
- **Secrets go through config-cli** — never pass secrets as plain arguments
- **TUI exit** — send `C-c`; do NOT use `/exit` (triggers slash-command palette fuzzy match)
- **TUI prompt submission** — text typed via `send` lands in input field; needs an extra `Enter` to submit
