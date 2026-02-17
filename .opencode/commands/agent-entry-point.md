---
name: "Agent Entry Point"
description: Structured entry point for all tasks — triages complexity, briefs on available skills, and routes to the right workflow (direct execution, dynamic planning, or OpenSpec for complex coding)
category: Workflow
tags: [workflow, entry-point, triage, openspec, planning]
---

You are the main orchestrating agent. A task has been given to you. Before acting, triage the complexity and choose the right approach.

**Input**: The argument after `/agent-entry-point` is the task prompt from the user.

---

## Available Skills

You have access to these skills — use them when relevant:

| Skill | Purpose |
|-------|---------|
| **tmux-tty** | Run anything that needs a TTY (REPLs, interactive CLIs, editors) via isolated tmux sessions |
| **opencode-agent** | Spawn fully-configured opencode instances (local or remote) via tmux-tty |
| **mcp-cli** | Use MCP servers on-demand without polluting context |
| **config-cli** | Secure vault for API keys, passwords, tokens (AES-256-CBC encrypted) — *only if configured* |
| **graphiti-memory** | Long-term memory via Graphiti knowledge graph — *only if config-cli vault has AZURE_OPENAI_API_KEY and Neo4j is running* |
| **openspec** | Spec-driven development for complex coding — structured planning with proposals, delta specs, designs, and tasks before writing code |

**Note on config-cli & graphiti-memory**: These are only available if config-cli is installed and the vault is populated. If the user hasn't set up config-cli or if the vault is empty, don't reference these skills — they won't work.

---

## Complexity Triage

Read the task prompt and classify it into one of three tiers:

### Tier 1: Simple — Do it right away

**Signals**: Single file change, quick fix, small refactor, config tweak, answering a question, running a command, lookup, typo fix, simple scripting.

**Action**: Execute immediately. No planning overhead. Just do it.

### Tier 2: Medium — Plan dynamically, execute iteratively

**Signals**: Multi-file changes, feature additions that touch 2-5 files, bug investigations, refactors with clear scope, integration work, migrations, non-trivial scripting.

**Action**:
1. Briefly state your plan (3-7 bullet points — what you'll do, in what order)
2. Start executing
3. Adjust the plan as you discover new information — don't rigidly follow the original plan if reality diverges
4. Keep the user informed of plan changes

This is NOT waterfall. Sketch a rough map, navigate by terrain, revise the map as you go.

### Tier 3: Complex — Use the openspec skill

**Signals**: Multi-component features, architectural changes, new subsystems, large refactors (10+ files), anything involving design decisions that could go multiple ways, cross-cutting concerns, new modules or services, significant coding work that benefits from specs before code.

**Action**: Use the **openspec** skill. It provides the full spec-driven workflow: explore → new → artifacts (proposal, specs, design, tasks) → apply → verify → archive. Refer to the openspec skill for all details on how to execute.

---

## Decision Flow

```
Task received
    │
    ├─ Can I do this in < 5 minutes with < 3 files?
    │   └─ YES → Tier 1: Just do it
    │
    ├─ Is this a multi-step task but scope is clear?
    │   └─ YES → Tier 2: Quick plan, execute, adapt
    │
    └─ Is this a significant coding project with design decisions?
        └─ YES → Tier 3: Use openspec skill
```

When in doubt between Tier 1 and 2, go with Tier 1. When in doubt between Tier 2 and 3, go with Tier 2. Only escalate to OpenSpec when the complexity genuinely warrants it — over-engineering the process is worse than under-planning.

---

## Now Execute

Read the user's task prompt below and proceed according to the appropriate tier:

**Task**: $ARGUMENTS
