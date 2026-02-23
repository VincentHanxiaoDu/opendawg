---
name: tmux-tty
description: Use tmux for ALL operations that need a TTY (interactive CLI tools, REPLs, editors, interactive git, full-screen terminal apps). Each session runs on its own isolated tmux socket so it never interferes with the user's tmux or other sessions. Use when running vim, nano, python REPL, git rebase -i, git add -p, htop, or any command requiring terminal interaction.
---

# tmux-tty

All TTY operations go through tmux with isolated sockets. Every session gets its own socket at `$TMPDIR/tmux-tty-sockets/<name>`, fully independent from each other and the user's tmux.

## Rule

**Any command that needs a TTY must use this skill.** Do not run interactive commands directly via Bash — they will hang. Always use the wrapper or the equivalent `tmux -S <socket>` commands.

## Wrapper

```bash
<skill-path>/tmux-wrapper.sh <action> <session-name> [args...]
```

| Action | Usage |
|--------|-------|
| `start <name> <cmd> [args]` | Create isolated session with its own socket |
| `send <name> <input>` | Send keys (use `Enter`, `Escape`, `C-c` etc.) |
| `capture <name>` | Read current screen output |
| `stop <name>` | Kill session and remove socket |
| `list` | List all tmux-tty sessions across all sockets |

## Direct tmux Commands (equivalent)

If not using the wrapper, always use `-S` for socket isolation:

```bash
SOCK="$TMPDIR/tmux-tty-sockets/myname"

# Start
tmux -S "$SOCK" new-session -d -s myname vim file.txt

# Send keys
tmux -S "$SOCK" send-keys -t myname ':wq' Enter

# Capture
tmux -S "$SOCK" capture-pane -t myname -p

# Stop
tmux -S "$SOCK" kill-server && rm -f "$SOCK"
```

## Special Keys

`Enter`, `Escape`, `C-c`, `C-x`, `C-d`, `Up`, `Down`, `Left`, `Right`, `Space`, `BSpace`, `Tab`

## Examples

### Python REPL
```bash
wrapper start py python3 -i
wrapper send py 'import math' Enter
wrapper send py 'print(math.pi)' Enter
wrapper capture py
wrapper stop py
```

### Vim
```bash
wrapper start ed vim "${TMPDIR:-/tmp}/file.txt"
sleep 0.3
wrapper send ed 'i' 'Hello' Escape ':wq' Enter
wrapper stop ed
```

### Interactive Git Rebase
```bash
tmux -S "$TMPDIR/tmux-tty-sockets/rebase" new-session -d -s rebase -c /repo git rebase -i HEAD~3
sleep 0.5
tmux -S "$TMPDIR/tmux-tty-sockets/rebase" capture-pane -t rebase -p
tmux -S "$TMPDIR/tmux-tty-sockets/rebase" send-keys -t rebase ':wq' Enter
```

## Pitfalls

- **Always sleep 0.3-0.5s** after `start` before first `capture` — let the command initialize
- **Always send `Enter` explicitly** — it's a separate argument, not `\n`
- **Always `stop` when done** — prevents orphaned sockets
- **Never use bare `tmux` without `-S`** — that hits the user's default server
