---
name: graphiti-memory
description: Long-term memory backed by Graphiti knowledge graph — persist and query knowledge across sessions with rich metadata
---

# graphiti-memory: Knowledge Graph Long-Term Memory

Persist facts, instructions, observations, and preferences into a Graphiti-powered knowledge graph (Neo4j + LLM). Query knowledge across sessions with semantic search.

Two scripts, two audiences:

| Script | Audience | Capabilities |
|--------|----------|-------------|
| **`graphiti-agent.sh`** | AI agents | CRUD per-item: search, remember, delete single episodes/edges. No clear, no service management. |
| **`graphiti-cli.sh`** | Humans / admin scripts | Full access: everything above + start/stop/status, clear graph, get-edge |

**Agents use `graphiti-agent.sh`**. Humans use `graphiti-cli.sh`.

## Behavior Rules

### 1. Search Before Asking

When encountering unknown information (user preferences, project conventions, prior decisions), search memory first:

```bash
graphiti-agent search "user preference for test framework"
```

Only ask the user if no relevant results are found.

### 2. Store on Instruction

When the user gives explicit instructions, facts, or preferences, store them immediately:

```bash
graphiti-agent remember "User prefers pytest over unittest for all Python projects" \
  --source user-instruction
```

### 3. Rich Metadata

The scripts auto-enrich with hostname, cwd, project, and timestamp. Add extra context via flags:

```bash
graphiti-agent remember "The auth service uses JWT with RS256" \
  --source observation \
  --metadata "component=auth-service" \
  --metadata "confidence=high"
```

### 4. Update by Storing New Facts

Graphiti does not support in-place updates. To correct a fact:
- **Preferred**: Store a new episode with the corrected information — Graphiti's temporal resolution ensures the latest fact wins
- **Alternative**: Delete the old episode first (`delete-episode <uuid>`), then store the new one

### 5. Multiple Entries OK

Store multiple entries for the same topic — Graphiti handles deduplication and entity resolution automatically.

### 6. Secret Injection

All sensitive values MUST be injected via `$(config-cli get <key>)`. Never pass plaintext secrets to any command.

### 7. MCP Alternative

For advanced usage or direct tool access, use `mcp call` via the mcp-cli skill:

```bash
mcp call search_memory_facts --params '{"query":"auth","group_ids":["opendawg"]}' http://localhost:8000/mcp
mcp call add_memory --params '{"name":"ep1","episode_body":"fact","group_id":"opendawg"}' http://localhost:8000/mcp
mcp call delete_episode --params '{"uuid":"<uuid>"}' http://localhost:8000/mcp
mcp call delete_entity_edge --params '{"uuid":"<uuid>"}' http://localhost:8000/mcp
mcp call clear_graph --params '{"group_ids":["opendawg"]}' http://localhost:8000/mcp
```

## Prerequisites

1. **config-cli** installed and authenticated (`bash skills/config-cli/scripts/install.sh`)
2. **mcp** CLI installed (`.opendawg/bin/mcp`)
3. **jq** for JSON processing
4. **Docker** with Compose V2
5. **Azure OpenAI credentials** stored: `config-cli set AZURE_OPENAI_API_KEY <key>` and `config-cli set AZURE_OPENAI_ENDPOINT <url>`

Install:
```bash
bash skills/graphiti-memory/scripts/install.sh
```

## Agent Commands (`graphiti-agent.sh`)

| Command | Description |
|---------|-------------|
| `graphiti-agent search <query>` | Search facts (semantic) |
| `graphiti-agent search-nodes <query>` | Search entity nodes |
| `graphiti-agent remember <text> [flags]` | Store a new episode |
| `graphiti-agent episodes [--last N]` | List recent episodes (default: 10) |
| `graphiti-agent get-edge <uuid>` | Get an entity edge by UUID |
| `graphiti-agent delete-episode <uuid>` | Delete one episode |
| `graphiti-agent delete-edge <uuid>` | Delete one entity edge |

## Admin Commands (`graphiti-cli.sh`)

All agent commands above, plus:

| Command | Description |
|---------|-------------|
| `graphiti-cli start` | Start Neo4j + Graphiti, inject secrets from config-cli |
| `graphiti-cli stop` | Stop all services |
| `graphiti-cli status` | Show service status, health, and MCP status |
| `graphiti-cli clear [--confirm]` | ⚠️ Clear ALL data for the current group |

## Workflow Examples

### Agent: Storing & Querying

```bash
graphiti-agent remember "Always use pnpm instead of npm for this project" \
  --source user-instruction

graphiti-agent remember "The API rate limit is 100 req/min per key" \
  --source observation \
  --metadata "service=api-gateway"

graphiti-agent search "package manager preference"

graphiti-agent search-nodes "BatchProcessor"

graphiti-agent episodes --last 20
```

### Agent: Correcting a Fact

```bash
# Option 1: Just store the correction (temporal resolution handles priority)
graphiti-agent remember "The API rate limit was increased to 500 req/min" \
  --source observation

# Option 2: Delete old, store new
graphiti-agent delete-episode "c61faa9a-ed5a-4f83-8122-4c630a5d8f48"
graphiti-agent remember "The API rate limit is 500 req/min per key" \
  --source observation
```

### Admin: Service Management

```bash
graphiti-cli start
graphiti-cli status
graphiti-cli stop
```

### Admin: Wiping Data

```bash
graphiti-cli clear --confirm
```

## Architecture

- **Neo4j 5.26.2**: Graph database for storing entities and relationships
- **Graphiti MCP Server**: LLM-powered knowledge extraction and semantic search
- **MCP Transport**: HTTP at `http://localhost:8000/mcp/`
- **Group ID**: Configurable via `GRAPHITI_GROUP_ID` env var (default: `opendawg`)

## Storage

- Docker volume `neo4j_data` persists the graph database
- Episodes are partitioned by `group_id` for multi-project support
- Docker Compose file: `skills/graphiti-memory/docker/docker-compose.yml`
