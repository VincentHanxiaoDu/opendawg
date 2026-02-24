# OpenDawg

OpenDawg is a plugin-based infrastructure layer for running [OpenCode](https://opencode.ai) as a headless server with composable services, messaging channels, and AI agent tooling.

## Architecture

```
Telegram / Discord / other channels
        │
        ▼
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│ channel plugins │────▶│ opencode     │────▶│ graphiti     │
│ (Docker)        │     │ serve :4096  │     │ (Docker)     │
└─────────────────┘     └──────────────┘     └──────┬───────┘
                                                     │
                                              ┌──────▼───────┐
                                              │ neo4j        │
                                              │ (Docker)     │
                                              └──────────────┘
```

## Quick Start

```bash
# 1. Install the CLI
npm install -g @opendawg/cli

# 2. Install and configure plugins
opendawg install graphiti-memory
opendawg configure graphiti-memory

opendawg install channel-telegram
opendawg configure channel-telegram

# 3. Start services
opendawg start
```

### Migrating from .env

If you have an existing `.env` file:

```bash
opendawg migrate
```

This converts your `.env` variables to the new YAML config format automatically.

## CLI Reference

| Command | Description |
|---------|-------------|
| `opendawg list` | Show all available plugins |
| `opendawg install <plugin>` | Install a plugin |
| `opendawg uninstall <plugin>` | Uninstall a plugin |
| `opendawg configure <plugin>` | Interactive configuration wizard |
| `opendawg configure <plugin> --key=value` | Non-interactive configuration |
| `opendawg start [plugins...]` | Start plugin services |
| `opendawg stop [plugins...]` | Stop plugin services |
| `opendawg status [plugin]` | Show plugin status |
| `opendawg migrate` | Convert .env to YAML config |
| `opendawg --help` | Show help |

## Plugins

### Core
| Plugin | Description | Execution |
|--------|-------------|-----------|
| **config-cli** | Encrypted vault for secrets (AES-256-CBC) | Docker / Native |

### Skills
| Plugin | Description | Execution |
|--------|-------------|-----------|
| **graphiti-memory** | Long-term memory via knowledge graph (Neo4j + LLM) | Docker |
| **cron-scheduler** | Distributed cron scheduling via Cronicle | Native |
| **tmux-tty** | Isolated TTY sessions for interactive tools | Native |
| **opendawg-agent** | Spawn and manage opencode instances | Native |
| **mcp-cli** | On-demand MCP server access via CLI | Native |
| **openspec** | Spec-driven development framework | Native |

### Channels
| Plugin | Description | Execution |
|--------|-------------|-----------|
| **channel-telegram** | Telegram bot connector | Docker |
| **channel-discord** | Discord bot connector | Docker |

## Configuration

Configuration uses hierarchical YAML with scoped plugin sections:

```
~/.opendawg/config.yaml    (global user-level defaults)
  ↓ overrides
./opendawg.yaml             (project-level config)
  ↓ overrides
CLI flags / env vars         (runtime overrides)
```

### Example `opendawg.yaml`

```yaml
plugins:
  graphiti-memory:
    enabled: true
    execution_mode: docker
    config:
      port: 8000
      azure_openai_api_key: "${vault:azure_openai_api_key}"
      azure_openai_endpoint: "${vault:azure_openai_endpoint}"

  channel-telegram:
    enabled: true
    execution_mode: docker
    config:
      bot_token: "${vault:telegram_bot_token}"
      allowed_user_ids: "123456,789012"
      server_url: "http://localhost:4096"
```

Secrets are stored in the config-cli vault and referenced as `${vault:key_name}`.

See [`opendawg.yaml.example`](opendawg.yaml.example) for full documentation of all options.

## Project Structure

```
opendawg/
├── cli/                    # @opendawg/cli — unified CLI tool
├── packages/
│   └── channel-core/       # @opendawg/channel-core — shared channel library
├── plugins/                # All plugins
│   ├── config-cli/         # Core: encrypted vault
│   ├── graphiti-memory/    # Skill: knowledge graph
│   ├── cron-scheduler/     # Skill: cron scheduling
│   ├── tmux-tty/           # Skill: TTY sessions
│   ├── opendawg-agent/     # Skill: agent spawning
│   ├── mcp-cli/            # Skill: MCP access
│   ├── openspec/           # Skill: spec-driven dev
│   ├── channel-telegram/   # Channel: Telegram
│   └── channel-discord/    # Channel: Discord
├── .opencode/              # AI agent configuration
├── opendawg.yaml           # Project plugin config
└── scripts/                # Setup scripts
```

Each plugin contains:
- `plugin.yaml` — manifest with metadata, dependencies, config schema, execution modes
- `ai/SKILL.md` — AI agent instructions
- `scripts/` — lifecycle hooks (install, configure, health)
- `docker-compose.yml` — Docker service definitions (if applicable)

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Build CLI only
npm run build:cli

# Link CLI for local development
cd cli && npm link
```
