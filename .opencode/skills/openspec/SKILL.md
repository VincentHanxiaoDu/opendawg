---
name: openspec
description: Spec-driven development framework for complex coding tasks. Use OpenSpec when the task involves multi-component features, architectural changes, large refactors (10+ files), new subsystems, or any significant coding work that benefits from structured planning before implementation. Triggers on mentions of openspec, opsx, spec-driven development, delta specs, change artifacts, proposals, or structured coding workflows. Also use when the /opendog command triages a task as Tier 3 (complex).
---

# OpenSpec — Spec-Driven Development

OpenSpec organizes complex work into **specs** (source of truth for current behavior) and **changes** (proposed modifications with artifacts and delta specs). Each change goes through a lifecycle: explore → create → plan → implement → verify → archive.

**Install**: `npm install -g @fission-ai/openspec@latest` (requires Node.js >= 20.19.0)
**Initialize**: `openspec init` (run once per project)

## Startup: Check Installation

Before using OpenSpec, verify it's available:

```bash
openspec --version
```

If not installed, install it:
```bash
npm install -g @fission-ai/openspec@latest
```

If not initialized in the project:
```bash
openspec init --tools opencode
```

---

## Workflow Overview

```
  explore ─── Think through the problem (optional)
     │
  new/ff ──── Create a change container + artifacts
     │
  continue ── Build artifacts one at a time (or ff for all at once)
     │           proposal → specs → design → tasks
     │
  apply ───── Implement tasks, check them off
     │
  verify ──── Validate implementation matches artifacts
     │
  sync ────── Merge delta specs into main specs (optional)
     │
  archive ─── Move completed change to archive
```

---

## Directory Structure

```
openspec/
├── specs/                      # Source of truth (current system behavior)
│   └── <domain>/
│       └── spec.md
├── changes/                    # Proposed modifications
│   ├── <change-name>/
│   │   ├── .openspec.yaml      # Change metadata
│   │   ├── proposal.md         # Why and what
│   │   ├── design.md           # How (technical approach)
│   │   ├── tasks.md            # Implementation checklist
│   │   └── specs/              # Delta specs
│   │       └── <domain>/
│   │           └── spec.md     # ADDED/MODIFIED/REMOVED requirements
│   └── archive/                # Completed changes
│       └── YYYY-MM-DD-<name>/
└── config.yaml                 # Project configuration
```

---

## CLI Reference

### Key Commands

| Command | Purpose |
|---------|---------|
| `openspec list [--json]` | List changes or specs |
| `openspec status --change <name> [--json]` | Artifact completion status |
| `openspec instructions <artifact> --change <name> [--json]` | Get enriched instructions for an artifact |
| `openspec instructions apply --change <name> [--json]` | Get implementation instructions |
| `openspec new change "<name>"` | Create a new change |
| `openspec validate --all [--json]` | Validate structural integrity |
| `openspec archive "<name>"` | Archive a completed change |
| `openspec schemas [--json]` | List available workflow schemas |
| `openspec show <item> [--json]` | Show change or spec details |

### JSON Output

Most commands support `--json` for structured output. Always use `--json` when parsing programmatically.

---

## Action: Explore

**When**: Requirements are unclear, comparing approaches, investigating before committing.

**Stance**: Curious, not prescriptive. This is thinking, not implementing.

1. Check what exists:
   ```bash
   openspec list --json
   ```

2. Investigate the codebase — read files, search code, draw ASCII diagrams.

3. **Never write code** in explore mode. You MAY create OpenSpec artifacts (proposals, designs) if asked — that's capturing thinking.

4. When ideas crystallize, offer to create a change — don't force it.

5. If a change already exists, read its artifacts for context. Offer to capture decisions into the relevant artifact (design.md, proposal.md, specs, tasks.md) but never auto-capture.

**Key principle**: Let the shape of the problem emerge. Use ASCII diagrams liberally.

---

## Action: New Change

**When**: Starting a new feature, fix, or modification.

1. Derive a kebab-case name from the task (e.g., "add user authentication" → `add-user-auth`).

2. Create the change:
   ```bash
   openspec new change "<name>"
   ```

3. Check status:
   ```bash
   openspec status --change "<name>" --json
   ```

4. Get instructions for the first artifact:
   ```bash
   openspec instructions <first-ready-artifact> --change "<name>" --json
   ```

5. **STOP** — show the template and wait for user direction. Do NOT create artifacts yet.

---

## Action: Fast-Forward (FF)

**When**: Scope is clear, create ALL planning artifacts at once.

1. Create the change (if not already):
   ```bash
   openspec new change "<name>"
   ```

2. Get the artifact build order:
   ```bash
   openspec status --change "<name>" --json
   ```

3. Loop through artifacts in dependency order:

   For each artifact with `status: "ready"`:
   ```bash
   openspec instructions <artifact-id> --change "<name>" --json
   ```

   The JSON includes:
   - `context`: Project background (**constraints for you — do NOT copy into artifact**)
   - `rules`: Artifact-specific rules (**constraints for you — do NOT copy into artifact**)
   - `template`: Structure to use for the output file
   - `instruction`: Schema-specific guidance
   - `outputPath`: Where to write the artifact
   - `dependencies`: Completed artifacts to read for context

   **CRITICAL**: `context` and `rules` guide what you write but must NEVER appear in the output file.

4. Read dependency artifacts → write the file → show progress → repeat.

5. Stop when all `applyRequires` artifacts are complete.

### Default Schema: spec-driven

```
proposal (root) → specs + design (parallel) → tasks (requires both)
```

**Artifact guidelines**:
- **proposal.md**: Why, What Changes, Capabilities (new/modified), Impact
- **specs/\<capability\>/spec.md**: Delta specs with ADDED/MODIFIED/REMOVED requirements using WHEN/THEN scenarios
- **design.md**: Context, Goals/Non-Goals, Decisions, Risks/Trade-offs
- **tasks.md**: Checkboxed task groups (`- [ ] 1.1 Description`)

---

## Action: Continue

**When**: Building artifacts one at a time (review each before proceeding).

1. Select the change:
   ```bash
   openspec list --json
   openspec status --change "<name>" --json
   ```

2. Pick the FIRST artifact with `status: "ready"`.

3. Get instructions, read dependencies, create ONE artifact.

4. Show what was created and what's now unlocked. **Stop after one artifact.**

---

## Action: Apply (Implement)

**When**: Tasks artifact exists, ready to write code.

1. Get implementation instructions:
   ```bash
   openspec instructions apply --change "<name>" --json
   ```

2. Read all context files from `contextFiles` in the output.

3. Loop through pending tasks:
   - Show which task is being worked on
   - Make code changes
   - Mark complete: `- [ ]` → `- [x]` in tasks.md
   - Continue to next task

4. **Pause if**:
   - Task is unclear → ask for clarification
   - Implementation reveals design issue → suggest updating artifacts
   - Error or blocker → report and wait

5. On completion, suggest archive.

---

## Action: Verify

**When**: Validating implementation before archiving.

Three verification dimensions:

| Dimension | What it checks |
|-----------|---------------|
| **Completeness** | All tasks done, all requirements implemented, scenarios covered |
| **Correctness** | Implementation matches spec intent, edge cases handled |
| **Coherence** | Design decisions reflected in code, patterns consistent |

1. Get status and context:
   ```bash
   openspec status --change "<name>" --json
   openspec instructions apply --change "<name>" --json
   ```

2. Read all available artifacts.

3. Check each dimension, reporting issues as:
   - **CRITICAL**: Must fix before archive
   - **WARNING**: Should fix
   - **SUGGESTION**: Nice to fix

4. Generate report with summary scorecard and actionable recommendations.

**Graceful degradation**: If only tasks.md exists, check tasks only. Add dimensions as more artifacts exist.

---

## Action: Sync Delta Specs

**When**: Merging delta specs into main specs (before or during archive).

This is **agent-driven** — read delta specs and directly edit main specs.

1. Find delta specs at `openspec/changes/<name>/specs/*/spec.md`.

2. For each capability:
   - Read delta spec (ADDED/MODIFIED/REMOVED/RENAMED sections)
   - Read main spec at `openspec/specs/<capability>/spec.md` (may not exist)
   - Apply changes intelligently:

   | Section | Action |
   |---------|--------|
   | `## ADDED Requirements` | Append to main spec |
   | `## MODIFIED Requirements` | Replace matching requirement (partial updates OK) |
   | `## REMOVED Requirements` | Delete from main spec |
   | `## RENAMED Requirements` | Rename header (FROM:/TO: format) |

3. **Key principle**: The delta represents *intent*, not wholesale replacement. Add a scenario without copying existing ones. Preserve content not mentioned in the delta.

4. Create new main spec if capability doesn't exist yet.

### Edge Case Rules

| Edge Case | Rule |
|-----------|------|
| RENAMED + MODIFIED | Apply rename first (update header), then apply modifications to renamed requirement |
| Capability doesn't exist in main | Create new `openspec/specs/<capability>/spec.md` with only the ADDED requirements |
| REMOVED requirement has child scenarios | Delete the entire requirement block (header + all scenarios) |
| Conflicting operations on same requirement | Priority: REMOVED > RENAMED > MODIFIED > ADDED. If REMOVED, ignore any MODIFIED/RENAMED for same requirement |
| MODIFIED adds new scenarios | Append new scenarios without replacing existing ones. Only replace scenarios explicitly listed |
| Partial scenario update | Match by scenario name; replace only the matched scenario, preserve others |
| Empty main spec after removals | Delete the spec file if no requirements remain |
| Archive date timezone | Use UTC (`date -u`) for archive directory naming |

---

## Action: Archive

**When**: Change is complete.

1. Check artifact and task completion:
   ```bash
   openspec status --change "<name>" --json
   ```

2. Warn (but don't block) on incomplete artifacts/tasks.

3. If delta specs exist, offer to sync before archiving.

4. Archive:
   ```bash
   mkdir -p openspec/changes/archive
   mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>
   ```

   Or use the CLI:
   ```bash
   openspec archive "<name>"
   ```

---

## Action: Bulk Archive

**When**: Archiving multiple completed changes.

1. List and select changes (multi-select).

2. Gather status for all selected changes.

3. **Detect spec conflicts**: When 2+ changes touch the same capability, search the codebase for implementation evidence.
   - Only one implemented → sync that one's specs
   - Both implemented → apply chronologically (older first)
   - Neither implemented → skip sync, warn

4. Show consolidated status table, get single confirmation, execute.

---

## Action: Onboard

**When**: User's first time with OpenSpec.

Walk through a complete cycle using a real codebase task:
1. Scan for small tasks (TODOs, FIXMEs, type issues)
2. Explore the problem briefly
3. Create change → proposal → specs → design → tasks
4. Implement and check off tasks
5. Archive

Follow the pattern: **EXPLAIN → DO → SHOW → PAUSE**. Target 15-20 minutes.

---

## Delta Spec Format

```markdown
## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST support TOTP-based two-factor authentication.

#### Scenario: 2FA enrollment
- WHEN the user enables 2FA in settings
- THEN a QR code is displayed for authenticator app setup

## MODIFIED Requirements

### Requirement: Session Expiration
The system MUST expire sessions after 15 minutes of inactivity.

#### Scenario: New scenario to add
- WHEN 15 minutes pass without activity
- THEN the session is invalidated

## REMOVED Requirements

### Requirement: Remember Me
Reason: Deprecated in favor of 2FA

## RENAMED Requirements

- FROM: `### Requirement: Old Name`
- TO: `### Requirement: New Name`
```

**Format rules**:
- Requirements: `### Requirement: <name>` (3 hashtags)
- Scenarios: `#### Scenario: <name>` (4 hashtags)
- RFC 2119 keywords: SHALL/MUST (absolute), SHOULD (recommended), MAY (optional)
- Every requirement needs at least one scenario

---

## Project Configuration

`openspec/config.yaml`:

```yaml
schema: spec-driven

context: |
  Tech stack: TypeScript, React, Node.js
  Testing: Jest + React Testing Library

rules:
  proposal:
    - Include rollback plan
  specs:
    - Use Given/When/Then format
  design:
    - Include sequence diagrams for complex flows
  tasks:
    - Break into 2-hour maximum chunks
```

- `context`: Injected into ALL artifact instructions (max 50KB)
- `rules`: Per-artifact constraints injected into matching artifact only

---

## Custom Schemas

Schemas define the artifact workflow (DAG of artifacts with dependencies).

```bash
openspec schemas --json              # List available schemas
openspec schema init <name>          # Create custom schema
openspec schema fork <source> [name] # Fork existing schema
```

Schema definition (`schema.yaml`):
```yaml
name: spec-driven
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    requires: [specs, design]
apply:
  requires: [tasks]
  tracks: tasks.md
```

---

## Guardrails

- **NEVER** copy `context` or `rules` from CLI instructions into artifact files — they are constraints for the agent
- Always read dependency artifacts before creating new ones
- In explore mode, never write application code
- Keep code changes minimal and scoped to each task during apply
- Pause on unclear requirements — don't guess
- Offer to sync delta specs before archiving
- The workflow is **fluid, not waterfall** — actions can be invoked anytime, artifacts updated mid-implementation
- When in doubt, prefer making reasonable decisions to keep momentum (except on critical ambiguity)
