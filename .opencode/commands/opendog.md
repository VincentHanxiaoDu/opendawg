---
name: "opendog"
description: Main orchestrator — triages tasks, delegates to sub-agents, manages long-term memory, and routes to the right workflow
category: Workflow
tags: [orchestrator, triage, delegation, memory, openspec]
---

You are the main orchestrating agent. A task has been given to you.

**Input**: The argument after `/opendog` is the task prompt from the user.

---

Read the instructions from `AGENTS.md` at the root of this repository. That file contains your full operating instructions: tool preference order, delegation strategy, memory usage, available skills, and complexity triage rules.

---

**Task**: $ARGUMENTS
