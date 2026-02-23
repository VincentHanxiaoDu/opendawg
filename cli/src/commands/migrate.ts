import type { Command } from 'commander';
import { loadConfig, saveProjectConfig } from '../lib/config.js';
import { info, success, warn, error, table } from '../utils/logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// ─── ENV_VAR_MAP ──────────────────────────────────────────────────────────────
// Maps existing .env variable names to plugin config targets.
// A single env var can map to multiple plugin/key targets (e.g. OPENCODE_SERVER_URLS).

interface EnvMapping {
  targets: Array<{ plugin: string; key: string }>;
  secret: boolean;
}

const ENV_VAR_MAP: Record<string, EnvMapping> = {
  // ── Azure OpenAI ──────────────────────────────────────────────────────
  AZURE_OPENAI_API_KEY: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_api_key' }],
    secret: true,
  },
  AZURE_OPENAI_ENDPOINT: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_endpoint' }],
    secret: false,
  },
  AZURE_OPENAI_DEPLOYMENT: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_deployment' }],
    secret: false,
  },
  AZURE_OPENAI_API_VERSION: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_api_version' }],
    secret: false,
  },
  AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_embeddings_deployment' }],
    secret: false,
  },
  AZURE_OPENAI_EMBEDDINGS_ENDPOINT: {
    targets: [{ plugin: 'graphiti-memory', key: 'azure_openai_embeddings_endpoint' }],
    secret: false,
  },

  // ── Config-CLI ────────────────────────────────────────────────────────
  CONFIG_CLI_TOKEN: {
    targets: [{ plugin: 'config-cli', key: 'token' }],
    secret: true,
  },
  CONFIG_CLI_PORT: {
    targets: [{ plugin: 'config-cli', key: 'port' }],
    secret: false,
  },

  // ── Neo4j / Graphiti ──────────────────────────────────────────────────
  NEO4J_PASSWORD: {
    targets: [{ plugin: 'graphiti-memory', key: 'neo4j_password' }],
    secret: true,
  },
  GRAPHITI_PORT: {
    targets: [{ plugin: 'graphiti-memory', key: 'port' }],
    secret: false,
  },
  NEO4J_HTTP_PORT: {
    targets: [{ plugin: 'graphiti-memory', key: 'neo4j_http_port' }],
    secret: false,
  },
  NEO4J_BOLT_PORT: {
    targets: [{ plugin: 'graphiti-memory', key: 'neo4j_bolt_port' }],
    secret: false,
  },

  // ── Global (OpenCode Server Auth) ─────────────────────────────────────
  OPENCODE_SERVER_PASSWORD: {
    targets: [{ plugin: '_global', key: 'opencode_server_password' }],
    secret: true,
  },
  OPENCODE_SERVER_USERNAME: {
    targets: [{ plugin: '_global', key: 'opencode_server_username' }],
    secret: false,
  },

  // ── Channel — Telegram ────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: {
    targets: [{ plugin: 'channel-telegram', key: 'bot_token' }],
    secret: true,
  },
  TELEGRAM_ALLOWED_USER_IDS: {
    targets: [{ plugin: 'channel-telegram', key: 'allowed_user_ids' }],
    secret: false,
  },
  ADMIN_USER_ID: {
    targets: [{ plugin: 'channel-telegram', key: 'admin_user_id' }],
    secret: false,
  },
  TELEGRAM_MESSAGE_DELETE_TIMEOUT: {
    targets: [{ plugin: 'channel-telegram', key: 'message_delete_timeout' }],
    secret: false,
  },

  // ── Shared: OpenCode Server URLs (Telegram + Discord) ─────────────────
  OPENCODE_SERVER_URLS: {
    targets: [
      { plugin: 'channel-telegram', key: 'server_urls' },
      { plugin: 'channel-discord', key: 'server_urls' },
    ],
    secret: false,
  },
  OPENCODE_SERVER_URL: {
    targets: [
      { plugin: 'channel-telegram', key: 'server_url' },
      { plugin: 'channel-discord', key: 'server_url' },
    ],
    secret: false,
  },

  // ── Channel — Discord ────────────────────────────────────────────────
  DISCORD_BOT_TOKEN: {
    targets: [{ plugin: 'channel-discord', key: 'bot_token' }],
    secret: true,
  },
  DISCORD_APP_ID: {
    targets: [{ plugin: 'channel-discord', key: 'app_id' }],
    secret: false,
  },
  DISCORD_ALLOWED_USER_IDS: {
    targets: [{ plugin: 'channel-discord', key: 'allowed_user_ids' }],
    secret: false,
  },
  DISCORD_ADMIN_USER_ID: {
    targets: [{ plugin: 'channel-discord', key: 'admin_user_id' }],
    secret: false,
  },
  DISCORD_MESSAGE_DELETE_TIMEOUT: {
    targets: [{ plugin: 'channel-discord', key: 'message_delete_timeout' }],
    secret: false,
  },
};

/**
 * Parse a .env file into a key-value map. Handles comments, blank lines,
 * and optionally quoted values.
 */
function parseEnvFile(content: string): Map<string, string> {
  const vars = new Map<string, string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === '' || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only add entries with non-empty keys
    if (key.length > 0) {
      vars.set(key, value);
    }
  }

  return vars;
}

/**
 * Store a single secret in the vault via config-cli.
 */
async function storeSecret(plugin: string, key: string, value: string): Promise<void> {
  const vaultKey = `opendawg/${plugin}/${key}`;
  await execFileAsync('config-cli', ['set', vaultKey, value]);
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate a .env file into opendawg.yaml and vault')
    .option('-f, --from <path>', 'Path to .env file', '.env')
    .action(async (opts: { from: string }) => {
      try {
        const envPath = path.resolve(opts.from);

        // Read the .env file
        let envContent: string;
        try {
          envContent = await fs.readFile(envPath, 'utf-8');
        } catch {
          error(`Could not read .env file at "${envPath}". Use --from to specify a path.`);
          process.exitCode = 1;
          return;
        }

        info(`Parsing .env file: ${envPath}`);
        const envVars = parseEnvFile(envContent);
        info(`Found ${envVars.size} variable(s) in .env file.`);

        if (envVars.size === 0) {
          info('No variables to migrate.');
          return;
        }

        const config = loadConfig();

        const mapped: Array<{ envVar: string; plugin: string; key: string; secret: boolean }> = [];
        const unmapped: string[] = [];
        let secretCount = 0;
        let errorCount = 0;

        for (const [envVar, value] of envVars) {
          const mapping = ENV_VAR_MAP[envVar];

          if (!mapping) {
            unmapped.push(envVar);
            continue;
          }

          // Skip empty values
          if (value === '' || value === undefined) {
            continue;
          }

          for (const target of mapping.targets) {
            const { plugin: pluginName, key } = target;

            // Ensure plugin section exists
            if (!config.plugins[pluginName]) {
              config.plugins[pluginName] = { enabled: false, config: {} };
            }

            if (mapping.secret) {
              // Store secret in vault
              try {
                await storeSecret(pluginName, key, value);
                config.plugins[pluginName].config[key] = `\${vault:opendawg/${pluginName}/${key}}`;
                secretCount++;
              } catch (vaultErr) {
                warn(
                  `Failed to store secret "${envVar}" -> ${pluginName}.${key} in vault: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`,
                );
                warn('Storing value in config file instead (not recommended for secrets).');
                config.plugins[pluginName].config[key] = value;
                errorCount++;
              }
            } else {
              // Store non-secret directly in config
              config.plugins[pluginName].config[key] = value;
            }

            mapped.push({
              envVar,
              plugin: pluginName,
              key,
              secret: mapping.secret,
            });
          }
        }

        // Save the updated config
        await saveProjectConfig(config);

        // Report results
        console.log('');
        if (mapped.length > 0) {
          success(`Mapped ${mapped.length} variable(s) to plugin config:`);
          table(
            ['Env Variable', 'Plugin', 'Config Key', 'Secret'],
            mapped.map((m) => [m.envVar, m.plugin, m.key, m.secret ? 'yes' : 'no']),
          );
        }

        if (unmapped.length > 0) {
          console.log('');
          warn(`${unmapped.length} variable(s) could not be mapped (no mapping defined):`);
          for (const v of unmapped) {
            console.log(`  - ${v}`);
          }
        }

        console.log('');
        if (secretCount > 0) {
          info(`${secretCount} secret(s) stored in vault.`);
        }
        if (errorCount > 0) {
          warn(`${errorCount} secret(s) could not be stored in vault and were written to config file.`);
        }

        success('Migration complete. Review opendawg.yaml and enable plugins as needed.');
      } catch (err) {
        error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
