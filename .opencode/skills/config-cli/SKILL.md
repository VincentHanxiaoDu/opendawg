---
name: config-cli
description: Secure key-value vault for managing sensitive credentials (API keys, passwords, tokens) — encrypted at rest with AES-256-CBC
---

# config-cli: Secure Credential Vault

Manage sensitive values (API keys, passwords, tokens) encrypted at rest. Values are stored in `.opendawg/vault/` (project root) using AES-256-CBC encryption with a master token as the passphrase. Project root is detected via `git rev-parse --show-toplevel` or overridden with the `OPENDAWG_ROOT` env var.

## Critical Rules

- **NEVER display plaintext secrets** in output, logs, or chat messages
- **ALWAYS** use `$(config-cli get <key>)` for injecting secrets into commands, configs, or environment variables
- When a user provides a sensitive value (API key, password, token), store it via `config-cli set` immediately — never echo it back
- Example safe usage: `AZURE_OPENAI_API_KEY=$(config-cli get AZURE_OPENAI_API_KEY) some-command`

## Prerequisites

Install via:
```bash
bash skills/config-cli/scripts/install.sh
```

Requires `openssl` (available on macOS and most Linux systems).

## Commands

| Command | Description |
|---------|-------------|
| `config-cli login <url>` | Extract token from URL (`?token=xxx`), store as master key |
| `config-cli set <key> <value>` | Encrypt value with master token, store in vault |
| `config-cli get <key>` | Decrypt and output value (for `$(...)` substitution) |
| `config-cli get-all` | Decrypt all keys, output `export KEY='VALUE'` lines (for `eval`) |
| `config-cli list` | List key names only (never values) |
| `config-cli delete <key>` | Remove a stored key |
| `config-cli status` | Show auth status and key count |

## Workflow

### Initial Setup

```bash
# Authenticate with a token URL
config-cli login "https://example.com?token=my-master-token"

# Store credentials
config-cli set AZURE_OPENAI_API_KEY your-azure-key
config-cli set AZURE_OPENAI_ENDPOINT https://your-resource.openai.azure.com/
config-cli set NEO4J_PASSWORD my-secret-password
```

### Using Secrets Safely

```bash
# Import all vault keys into current shell at once
eval "$(config-cli get-all)"

# Or inject a single key
MY_KEY=$(config-cli get MY_KEY) some-command

# Inject into docker compose
eval "$(config-cli get-all)" && docker compose up -d
```

### Managing Keys

```bash
# See what's stored
config-cli list

# Check status
config-cli status

# Rotate a key
config-cli set OPENAI_API_KEY sk-proj-new-key

# Remove a key
config-cli delete OLD_KEY
```

## Storage Details

- **Token**: `.opendawg/.token` (chmod 600)
- **Vault**: `.opendawg/vault/<key>.enc` (AES-256-CBC, chmod 600)
- **Config dir**: `.opendawg/` in project root (chmod 700)
- **Binaries**: `.opendawg/bin/` — symlinks to CLI scripts
- **Project root**: Detected via `git rev-parse --show-toplevel`, override with `OPENDAWG_ROOT` env var
