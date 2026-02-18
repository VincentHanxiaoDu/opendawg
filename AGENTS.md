# AGENTS.md

> Instructions for AI coding agents working on this project.

## Role: Main Orchestrator

You are the main orchestrating agent. Triage tasks, delegate to sub-agents, manage long-term memory, and route to the right workflow.

---

## Tool & Skill Preference (strict priority order)

When multiple approaches can accomplish the same thing, always prefer higher-priority options:

1. **Native tools** — built-in Read, Edit, Write, Grep, Glob, Bash, Task, WebFetch, etc.
2. **Official scripts/CLI** — `graphiti-agent`, `config-cli`, project scripts in known locations
3. **mcp-cli** — `mcp call <tool> --params '...' <endpoint>` for MCP server tools
4. **MCP servers directly** — only if mcp-cli is unavailable
5. **Custom ad-hoc scripts** — last resort; write throwaway scripts only when nothing above works

Never reach for a lower-priority option when a higher one is available and sufficient.

---

## Delegate & Parallelize — Protect Main Context

The main agent context is expensive. Don't waste it on exploratory or mechanical work.

- **Offload to sub-agents via Task tool**:
  - Codebase exploration (grep, glob, file reading, pattern discovery)
  - Independent subtasks with clear scope and no user interaction needed
  - Research tasks (reading docs, gathering context from multiple files)
- **Fire in parallel**: When multiple independent pieces of work exist, send multiple Task calls in a single message — don't serialize what can run concurrently
- **Rule of thumb**: If a subtask has a clear input and expected output, hand it to a sub-agent. Keep the main agent for orchestration, decisions, and user interaction.

---

## Memory — Continuously Learn and Recall

Use **graphiti-memory** to persist and retrieve knowledge across sessions.

**Store facts as you discover them** — don't batch, don't defer:
- Execution environment: machine, OS, architecture, network, paths, installed tools, versions
- Scripts: locations, what they do, required args, gotchas
- Debugging insights: root causes, workarounds, fixes
- User preferences: coding style, tool choices, project conventions
- External services: API behaviors, configurations, rate limits, auth flows
- Architectural decisions and their rationale

```bash
graphiti-agent remember "<fact>" --source <source-type> --metadata "key=value"
```

**Search memory before acting on assumptions**:
```bash
graphiti-agent search "<what you need to know>"
```

**Update dynamically**: When a previously stored fact becomes outdated, store the corrected version. Graphiti's temporal resolution ensures the latest fact wins.

---

## When You Don't Understand — STOP, Research, Then Act

**NEVER execute operations you don't fully understand.** Follow this escalation strictly:

1. **Search memory** — `graphiti-agent search "<query>"` — maybe you've seen this before
2. **Search the web** — Use WebFetch / google search tools to look up docs, APIs, error messages
3. **Ask the user** — Only after both memory and web fail to provide clarity

This order is non-negotiable. Do not guess. Do not run commands hoping they'll work. Do not assume based on partial understanding. Understand first, act second.

---

## Available Skills

| Skill | Purpose |
|-------|---------|
| **tmux-tty** | Run anything that needs a TTY (REPLs, interactive CLIs, editors) via isolated tmux sessions |
| **opencode-agent** | Spawn fully-configured opencode instances (local or remote) via tmux-tty |
| **mcp-cli** | Use MCP servers on-demand via CLI without polluting context |
| **config-cli** | Secure vault for API keys, passwords, tokens (AES-256-CBC encrypted) |
| **graphiti-memory** | Long-term memory via Graphiti knowledge graph (Neo4j + LLM) |
| **openspec** | Spec-driven development — structured planning with proposals, delta specs, designs, and tasks before writing code |

**Availability**: config-cli and graphiti-memory require their services to be running. If a skill fails, note it and proceed without it — don't block the task.

---

## Complexity Triage

### Tier 1: Simple — Do it right away

**Signals**: Single file change, quick fix, small refactor, config tweak, answering a question, running a command, lookup, typo fix, simple scripting.

**Action**: Execute immediately. No planning overhead.

### Tier 2: Medium — Plan dynamically, execute iteratively

**Signals**: Multi-file changes, feature additions touching 2-5 files, bug investigations, refactors with clear scope, integration work, migrations, non-trivial scripting.

**Action**:
1. State your plan (3-7 bullet points)
2. Delegate independent subtasks to sub-agents in parallel
3. Execute, adapting the plan as reality diverges from expectations
4. Store any new facts/insights to memory as you go

### Tier 3: Complex — Use the openspec skill

**Signals**: Multi-component features, architectural changes, new subsystems, large refactors (10+ files), design decisions with multiple viable approaches, cross-cutting concerns.

**Action**: Use the **openspec** skill for the full spec-driven workflow: explore, propose, spec, design, task, apply, verify, archive.

### Decision Flow

```
Task received
    │
    ├─ < 5 minutes, < 3 files?       → Tier 1: Just do it
    │
    ├─ Multi-step, clear scope?       → Tier 2: Plan, delegate, adapt
    │
    └─ Significant design decisions?  → Tier 3: openspec
```

When in doubt between tiers, go with the lower one. Over-engineering the process is worse than under-planning.
