---
name: opencode-agent
description: Spawn and manage fully-configured opencode CLI sessions via tmux-tty. Use when the user wants to launch opencode on a local or remote machine, bootstrap opencode environments with skills from a git repo, set up config-cli auth and vault secrets for opencode, or orchestrate opencode agents through tmux sessions. Also triggers when the user mentions opencode-agent, spawning agents, remote opencode, or multi-machine opencode orchestration.
---

# opencode-agent

Bootstrap and launch opencode with full environment setup — skills from a git repo, config-cli auth, vault secrets, and opencode/oh-my-opencode installation — then control it through tmux-tty.

## Workflow

### 1. Create a tmux TTY session

Use the tmux-tty skill to create an isolated session (local or remote):

```bash
# Local
<tmux-skill-path>/tmux-wrapper.sh start oc bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'cd /path/to/project' Enter

# Remote (SSH)
<tmux-skill-path>/tmux-wrapper.sh start oc-remote ssh user@host
<tmux-skill-path>/tmux-wrapper.sh send oc-remote 'cd /path/to/project' Enter
```

### 2. Run the bootstrap script

Send the bootstrap command into the tmux session:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opencode-agent.sh \
  --repo https://github.com/user/opendog.git \
  --config-cli-endpoint "https://..." ' Enter
```

The script will:
1. Clone/pull the repo and merge `.opencode/skills/` into the project
2. Install and authenticate config-cli
3. Inject environment variables from the vault
4. Install or update opencode and oh-my-opencode
5. Launch opencode with `exec` (replaces shell process)

### 3. Authenticate (if needed)

If opencode needs auth, quit and run it interactively:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc '/exit' Enter
sleep 0.5
<tmux-skill-path>/tmux-wrapper.sh send oc 'opencode auth login' Enter
sleep 2
<tmux-skill-path>/tmux-wrapper.sh capture oc
```

### 4. Interact with opencode

Send prompts and capture output:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc 'implement the login feature' Enter
sleep 3
<tmux-skill-path>/tmux-wrapper.sh capture oc
```

### 5. Reload with session continuity

Quit opencode and re-run the bootstrap with the session ID:

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc '/exit' Enter
sleep 0.5
<tmux-skill-path>/tmux-wrapper.sh send oc 'bash <skill-path>/scripts/opencode-agent.sh -s <session-id>' Enter
```

### 6. Quit and cleanup

```bash
<tmux-skill-path>/tmux-wrapper.sh send oc '/exit' Enter
sleep 0.5
<tmux-skill-path>/tmux-wrapper.sh stop oc
```

## Script Arguments

```bash
bash <skill-path>/scripts/opencode-agent.sh [options] [opencode-args...]
```

| Flag | Arg | Purpose |
|------|-----|---------|
| `--repo` | `<url>` | Git repo URL containing `.opencode/skills/` (required on first run) |
| `--repo-branch` | `<branch>` | Branch to clone/pull (default: main) |
| `--config-cli-endpoint` | `<url>` | Run `config-cli login <url>` |
| `--config-cli-token` | `<token>` | Login with token |
| `--graphiti-group-id` | `<id>` | Override GRAPHITI_GROUP_ID (default: opendog) |
| `--graphiti-model` | `<model>` | Override MODEL_NAME for graphiti |
| `-s, --session` | `<id>` | Continue specific opencode session |
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

- **Always `sleep` after `send`** before `capture` — let commands initialize
- **Always `stop` tmux sessions** when done — prevents orphaned sockets
- **Secrets go through config-cli** — never pass secrets as plain arguments in shared environments
- **`exec opencode`** replaces the shell — the tmux session becomes the opencode process
- **First run needs `--repo`** — subsequent runs use the cached clone in `$TMPDIR`
- **Session continuity** — use `-s <session-id>` to resume; omit to start fresh
