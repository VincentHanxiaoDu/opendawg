# OpenDog

OpenDog is an infrastructure layer for running [OpenCode](https://opencode.ai) as a headless server with Docker-managed services and messaging channels.

## Architecture

```
Telegram / other channels
        │
        ▼
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│ channel-telegram│────▶│ opencode     │────▶│ graphiti     │
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
# 1. Copy and fill in your environment variables
cp .env.example .env

# 2. Start everything (opencode server + all Docker services)
./opencode-server.sh --start-all
```

## Services

| Service | Flag | Description |
|---------|------|-------------|
| **opencode serve** | *(always runs)* | Headless AI coding server on port 4096 |
| **channel-telegram** | `--channel=telegram` | Telegram bot bridge (pure HTTP client) |
| **graphiti + neo4j** | `--graphiti` | Knowledge graph for long-term memory |
| **config-cli** | `--config-cli` | Encrypted vault for secrets |

Use `--start-all` to launch all Docker services at once.

All Docker services must pass health checks before `opencode serve` starts.

## Configuration

See [`.env.example`](.env.example) for all available environment variables.

### Telegram Channel

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your numeric user ID (not username)
3. Set in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_ALLOWED_USER_IDS=your-user-id
   ADMIN_USER_ID=your-user-id
   ```

## Project Structure

```
opencode-server.sh          # Main entry point — bootstraps and launches opencode serve
docker-compose.yml          # All Docker services (profiles: graphiti, config-cli, telegram)
.env.example                # Environment variable template

channel/
  telegram/                 # Patched opencode-telegram (pure client, no auto-spawn)

Dockerfile.channel-telegram # Docker build for Telegram channel
Dockerfile.config-cli       # Docker build for config-cli vault
graphiti-config.yaml        # Graphiti knowledge graph configuration
```
