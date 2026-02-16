---
name: graphiti-memory
description: Long-term memory backed by Graphiti knowledge graph — persist and query knowledge across sessions with rich metadata
---

# graphiti-memory: Knowledge Graph Long-Term Memory

Persist facts, instructions, observations, and preferences into a Graphiti-powered knowledge graph (Neo4j + LLM). Query knowledge across sessions with semantic search.

## Behavior Rules

### 1. Search Before Asking

When encountering unknown information (user preferences, project conventions, prior decisions), search memory first:

```bash
graphiti-cli search "user preference for test framework"
```

Only ask the user if no relevant results are found.

### 2. Store on Instruction

When the user gives explicit instructions, facts, or preferences, store them immediately:

```bash
graphiti-cli remember "User prefers pytest over unittest for all Python projects" \
  --source user-instruction
```

### 3. Rich Metadata

Always include context so facts are unambiguous. The CLI auto-enriches with hostname, cwd, project, and timestamp. Add extra context via flags:

```bash
graphiti-cli remember "The auth service uses JWT with RS256" \
  --source observation \
  --metadata "component=auth-service" \
  --metadata "confidence=high"
```

### 4. Multiple Entries OK

Store multiple entries for the same topic — Graphiti handles deduplication and entity resolution automatically.

### 5. Conflict Resolution

When facts change, store the new fact. Graphiti's temporal awareness handles versioning — newer facts take precedence.

### 6. Secret Injection

All sensitive values MUST be injected via `$(config-cli get <key>)`. Never pass plaintext secrets to any command.

### 7. MCP Alternative

For advanced usage or direct tool access, use `mcp call` via the mcp-cli skill:

```bash
mcp call search_memory_facts --params '{"query":"auth","group_ids":["opendog"]}' http://localhost:8000/mcp
mcp call add_memory --params '{"name":"ep1","episode_body":"fact","group_id":"opendog"}' http://localhost:8000/mcp
mcp call search_nodes --params '{"query":"auth","group_ids":["opendog"]}' http://localhost:8000/mcp
mcp call get_episodes --params '{"group_ids":["opendog"],"max_episodes":10}' http://localhost:8000/mcp
```

## Prerequisites

1. **config-cli** installed and authenticated (`bash skills/config-cli/scripts/install.sh`)
2. **mcp** CLI installed (`.opendog/bin/mcp`)
3. **jq** for JSON processing
4. **Docker** with Compose V2
5. **Azure OpenAI credentials** stored: `config-cli set AZURE_OPENAI_API_KEY <key>` and `config-cli set AZURE_OPENAI_ENDPOINT <url>`

Install graphiti-cli:
```bash
bash skills/graphiti-memory/scripts/install.sh
```

## Commands

| Command | Description |
|---------|-------------|
| `graphiti-cli start` | Start Neo4j + Graphiti, inject secrets from config-cli |
| `graphiti-cli stop` | Stop all services |
| `graphiti-cli status` | Show service status and health |
| `graphiti-cli search <query>` | Search facts in the knowledge graph |
| `graphiti-cli search-nodes <query>` | Search entity nodes |
| `graphiti-cli remember <text> [flags]` | Store a new episode with auto-enriched metadata |
| `graphiti-cli episodes [--last N]` | List recent episodes (default: 10) |

## Workflow Examples

### Storing Knowledge

```bash
# User instruction
graphiti-cli remember "Always use pnpm instead of npm for this project" \
  --source user-instruction

# Technical observation
graphiti-cli remember "The API rate limit is 100 req/min per key" \
  --source observation \
  --metadata "service=api-gateway"

# Debugging insight
graphiti-cli remember "OOM errors in worker are caused by unbounded queue in BatchProcessor" \
  --source debugging \
  --metadata "component=worker" \
  --metadata "severity=critical"
```

### Querying Knowledge

```bash
# Semantic search for facts
graphiti-cli search "package manager preference"

# Search for entity nodes
graphiti-cli search-nodes "BatchProcessor"

# Recent episodes
graphiti-cli episodes --last 20
```

### Service Management

```bash
# Start (auto-injects Azure OpenAI credentials from config-cli vault)
graphiti-cli start

# Check health
graphiti-cli status

# Stop when done
graphiti-cli stop
```

## Architecture

- **Neo4j 5.26.2**: Graph database for storing entities and relationships
- **Graphiti MCP Server**: LLM-powered knowledge extraction and semantic search
- **MCP Transport**: HTTP at `http://localhost:8000/mcp/`
- **Group ID**: Configurable via `GRAPHITI_GROUP_ID` env var (default: `opendog`)

## Storage

- Docker volume `neo4j_data` persists the graph database
- Episodes are partitioned by `group_id` for multi-project support
- Docker Compose file: `skills/graphiti-memory/docker/docker-compose.yml`
