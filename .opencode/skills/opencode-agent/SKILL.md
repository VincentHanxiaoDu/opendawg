---
name: opencode-agent
description: Spawn and manage fully-configured opencode CLI sessions via tmux-tty. Use when the user wants to launch opencode on a local or remote machine, bootstrap opencode environments with skills from a git repo, set up config-cli auth and vault secrets for opencode, or orchestrate opencode agents through tmux sessions. Also triggers when the user mentions opencode-agent, spawning agents, remote opencode, or multi-machine opencode orchestration.
---

# opencode-agent

Bootstrap and launch opencode with full environment setup — skills from a git repo, config-cli auth, vault secrets, and opencode/oh-my-opencode installation — then control it through tmux-tty.

## CLI vs TUI Mode

The script defaults to **CLI mode** (`opencode run --format json`) — non-interactive, one prompt per invocation, JSON events to stdout. This is the **preferred mode for tmux automation**: structured output, no TUI artifacts, and the script prints the session ID for precise continuation.

Use `--tui` only when the user explicitly requests interactive exploration.

| Mode | Command | Output | Session tracking |
|------|---------|--------|------------------|
| **CLI (default)** | `opencode run --format json` | JSON events + `[opencode-agent] session=<id>` | Caller captures ID, passes `-s <id>` |
| **TUI** | `opencode` (with `--tui`) | TUI rendering | Manual |

## Best Practice: Session Tracking with `-s`

**ALWAYS use `-s <session-id>` for session continuity.** Never rely on `-c` (continue last) — it is ambiguous when multiple agents run in parallel.

The script outputs `[opencode-agent] session=<id>` after every CLI run. The caller (e.g. Sisyphus via tmux) captures this ID from the output and passes it back on the next invocation.

```
1st run:  opencode-agent.sh "build the auth module"
          → JSON output...
          → [opencode-agent] session=ses_abc123

2nd run:  opencode-agent.sh -s ses_abc123 "add rate limiting"
          → continues the exact same session

3rd run:  opencode-agent.sh -s ses_abc123 "write tests"
          → still the same session
```

To extract the session ID from tmux capture output:
```bash
grep -o 'session=ses_[^ ]*' <<< "$CAPTURED_OUTPUT" | tail -1 | cut -d= -f2
```

## Workflow (CLI Mode — Recommended)

### 1. Create a tmux TTY session

```bash
<tmux-skill-path>/tmux-wrapper.sh start oc bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'cd /path/to/project' Enter
```

### 2. Bootstrap + first prompt

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opencode-agent.sh \
  --repo https://github.com/VincentHanxiaoDu/opendog \
  --config-cli-endpoint "https://..." \
  "implement the login feature"' Enter
```

The script will:
1. Clone/pull the repo and merge `.opencode/skills/` into the project
2. Install and authenticate config-cli, inject env vars from vault
3. Install or update opencode and oh-my-opencode
4. Run `opencode run --format json "implement the login feature"`
5. After completion, print `[opencode-agent] session=ses_xxx` and return to shell

### 3. Capture output + session ID

```bash
sleep 30
OUTPUT=$(<tmux-skill-path>/tmux-wrapper.sh capture oc)
SID=$(echo "$OUTPUT" | grep -o 'session=ses_[^ ]*' | tail -1 | cut -d= -f2)
```

`$SID` now holds the session ID (e.g. `ses_abc123`). JSON events in `$OUTPUT` contain the full response.

### 4. Continue the session

Pass the captured session ID with `-s`:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc "opencode run --format json -s $SID \"add unit tests\"" Enter
```

Or via the bootstrap script (re-applies env setup):

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc "bash <skill-path>/scripts/opencode-agent.sh \
  -s $SID \"add unit tests\"" Enter
```

### 5. Cleanup

```bash
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

No exit command needed — CLI mode runs to completion and returns to shell.

## Workflow (TUI Mode)

Use `--tui` to launch the interactive terminal UI.

### Launch

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opencode-agent.sh \
  --tui --repo https://github.com/VincentHanxiaoDu/opendog \
  --config-cli-endpoint "https://..."' Enter
```

### Interact

Send prompts into the TUI input area. **Important**: the prompt text is typed into the input field; you must send an extra `Enter` to submit:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'implement the login feature' Enter
# The text is now in the input field — send Enter again to submit
sleep 0.5
<tmux-skill-path>/tmux-wrapper.sh send oc Enter
```

### Quit TUI

**`/exit` does NOT work via tmux** — the `/` triggers a slash-command palette and `exit` gets fuzzy-matched to a wrong command (e.g. `Agent Entry Point`).

Correct exit procedure:

```bash
# 1. Open command palette
<tmux-skill-path>/tmux-wrapper.sh send oc C-p
sleep 0.5

# 2. Search for exit
<tmux-skill-path>/tmux-wrapper.sh send oc 'exit'
sleep 0.5

# 3. Select "Exit the app"
<tmux-skill-path>/tmux-wrapper.sh send oc Enter
sleep 1

# 4. Cleanup tmux session
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

If graceful exit fails, force-kill with `stop`:

```bash
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

### Authenticate (if needed)

If opencode needs auth, exit TUI first and run auth interactively:

```bash
# Exit TUI (use Ctrl+P method above), then:
<tmux-skill-path>/tmux-wrapper.sh send oc 'opencode auth login' Enter
sleep 2
<tmux-skill-path>/tmux-wrapper.sh capture oc
```

## Script Arguments

```bash
bash <skill-path>/scripts/opencode-agent.sh [options] [prompt...]
```

| Flag | Arg | Purpose |
|------|-----|---------|
| `--repo` | `<url>` | Git repo URL containing `.opencode/skills/` (required on first run) |
| `--repo-branch` | `<branch>` | Branch to clone/pull (default: main) |
| `--config-cli-endpoint` | `<url>` | Run `config-cli login <url>` |
| `--config-cli-token` | `<token>` | Login with token |
| `--graphiti-group-id` | `<id>` | Override GRAPHITI_GROUP_ID (default: opendog) |
| `--graphiti-model` | `<model>` | Override MODEL_NAME for graphiti |
| `-s, --session` | `<id>` | Continue specific session (**preferred** for automation) |
| `-c, --continue` | - | Continue the last session (unsafe with parallel agents) |
| `--tui` | - | Launch interactive TUI instead of CLI mode |
| `--log-level` | `<level>` | Override default DEBUG |
| `-h, --help` | - | Show help (includes `opencode --help`) |

All unrecognized flags pass through to opencode.

## oh-my-opencode Management

The bootstrap script automatically handles oh-my-opencode installation and updates via `scripts/setup-oh-my-opencode.sh`. This consolidated script:

- Detects bun or npm as the package runner
- Checks if oh-my-opencode is installed and what version
- Installs if missing, updates if outdated
- Runs post-install/update diagnostics

Manual run:
```bash
bash <skill-path>/scripts/setup-oh-my-opencode.sh
```

## Version Check

Check if opencode has an update available:

```bash
bash <skill-path>/scripts/check-opencode.sh
```

Output JSON: `{"installed": bool, "current": "x.y.z", "latest": "x.y.z", "update_available": bool}`
Exit 0 = update available, exit 1 = up to date or error.

## Environment Variables

The bootstrap injects these from config-cli vault:

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
- **bun or npm** — for oh-my-opencode
- **rsync** — for incremental skills merge

## Pitfalls

- **Always use `-s <id>`, never `-c` for automation** — `-c` picks "last session" globally, which breaks with parallel agents
- **Prefer CLI mode for automation** — structured JSON output, no TUI artifacts, no exit issues
- **Always `sleep` after `send`** before `capture` — let commands initialize
- **Always `stop` tmux sessions** when done — prevents orphaned sockets
- **Secrets go through config-cli** — never pass secrets as plain arguments in shared environments
- **`exec opencode`** replaces the shell — in TUI mode the tmux session becomes the opencode process
- **First run needs `--repo`** — subsequent runs use the cached clone in `$TMPDIR`
- **TUI `/exit` broken via tmux** — `/` triggers slash-command palette; use `Ctrl+P → exit → Enter` instead
- **TUI prompt submission** — text typed via `send` lands in input field; needs an extra `Enter` to submit
