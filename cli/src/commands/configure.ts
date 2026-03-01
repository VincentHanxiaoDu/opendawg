import type { Command } from 'commander';
import { discoverPlugins, findPlugin } from '../lib/plugin-manager.js';
import { loadConfig, saveProjectConfig, getPluginConfig, getServerConfig } from '../lib/config.js';
import { validateConfig, applyDefaults, maskSecrets } from '../lib/schema-validator.js';
import type { ConfigFieldSchema } from '../lib/plugin-manifest.js';
import { info, success, warn, error } from '../utils/logger.js';
import { promptForConfig } from '../utils/prompts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

/** Schema for the top-level server config section. */
const SERVER_SCHEMA: Record<string, ConfigFieldSchema> = {
  port: {
    type: 'integer',
    default: 4096,
    description: 'Port for the opencode server',
  },
  hostname: {
    type: 'string',
    default: '127.0.0.1',
    description: 'Hostname/IP to bind the opencode server to',
  },
  yolo: {
    type: 'boolean',
    default: false,
    description: 'Bypass all permission prompts (YOLO mode)',
  },
};

/**
 * Store a single secret value in the vault via config-cli.
 */
async function storeSecret(pluginName: string, key: string, value: string): Promise<void> {
  const vaultKey = `opendawg/${pluginName}/${key}`;
  await execFileAsync('config-cli', ['set', vaultKey, value]);
}

/**
 * Determine which fields in a schema are secrets.
 */
function getSecretKeys(schema: Record<string, ConfigFieldSchema>): Set<string> {
  const secrets = new Set<string>();
  for (const [key, field] of Object.entries(schema)) {
    if (field.secret) {
      secrets.add(key);
    }
  }
  return secrets;
}

export function registerConfigureCommand(program: Command): void {
  program
    .command('configure')
    .description('Configure a plugin or the server (interactive or via --key=value flags)')
    .argument('<target>', 'Plugin name or "server" to configure')
    .option('-k, --kv <pairs...>', 'Key=value pairs for non-interactive mode')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (pluginName: string, opts: { kv?: string[] }, cmd: Command) => {
      try {
        // ── Special case: "server" configures the top-level server section ──
        if (pluginName === 'server') {
          await configureServer(opts, cmd);
          return;
        }

        const plugins = await discoverPlugins(PLUGINS_DIR);
        const plugin = findPlugin(plugins, pluginName);

        if (!plugin) {
          error(`Plugin "${pluginName}" not found. Run 'opendawg list' to see available plugins.`);
          process.exitCode = 1;
          return;
        }

        const schema = plugin.manifest.config?.schema ?? {};
        if (Object.keys(schema).length === 0) {
          info(`Plugin "${pluginName}" has no configurable fields.`);
          return;
        }

        const secretKeys = getSecretKeys(schema);
        const config = loadConfig();
        const existingPluginConfig = getPluginConfig(config, pluginName);
        const existing = existingPluginConfig.config;

        let newValues: Record<string, any>;

        // Parse --key=value pairs from both --kv and unknown options
        const rawPairs: string[] = [...(opts.kv ?? [])];

        // Also extract any unknown --key=value options from the raw args
        const rawArgs = cmd.args ?? [];
        for (const arg of rawArgs) {
          if (arg.startsWith('--') && arg.includes('=')) {
            rawPairs.push(arg.slice(2)); // strip leading --
          }
        }

        if (rawPairs.length > 0) {
          // Non-interactive mode
          info(`Configuring "${pluginName}" (non-interactive)...`);

          const parsed: Record<string, any> = {};
          for (const pair of rawPairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) {
              error(`Invalid key=value pair: "${pair}". Expected format: key=value`);
              process.exitCode = 1;
              return;
            }
            const key = pair.slice(0, eqIdx);
            const val = pair.slice(eqIdx + 1);

            if (!(key in schema)) {
              warn(`Unknown config key "${key}" for plugin "${pluginName}". Skipping.`);
              continue;
            }

            // Coerce type based on schema
            const fieldSchema = schema[key];
            if (fieldSchema.type === 'integer') {
              const num = parseInt(val, 10);
              if (Number.isNaN(num)) {
                error(`Invalid integer for key "${key}": ${val}`);
                process.exitCode = 1;
                return;
              }
              parsed[key] = num;
            } else if (fieldSchema.type === 'boolean') {
              parsed[key] = val === 'true' || val === '1';
            } else if (fieldSchema.type === 'array') {
              parsed[key] = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            } else {
              parsed[key] = val;
            }
          }

          newValues = { ...existing, ...parsed };
        } else {
          // Interactive mode
          info(`Configuring "${pluginName}" interactively...`);
          newValues = await promptForConfig(schema, existing);
        }

        // Apply defaults for any unset fields
        newValues = applyDefaults(newValues, schema);

        // Validate against plugin schema
        const validationErrors = validateConfig(newValues, schema);
        if (validationErrors.length > 0) {
          error('Configuration validation failed:');
          for (const e of validationErrors) {
            error(`  - ${e.field}: ${e.message}`);
          }
          process.exitCode = 1;
          return;
        }

        // Separate secrets from non-secrets
        const configValues: Record<string, any> = {};
        const secretsToStore: Array<{ key: string; value: string }> = [];

        for (const [key, value] of Object.entries(newValues)) {
          if (secretKeys.has(key) && value !== undefined && value !== null && String(value).length > 0) {
            secretsToStore.push({ key, value: String(value) });
            // Store a vault reference in the config file
            configValues[key] = `\${vault:opendawg/${pluginName}/${key}}`;
          } else {
            configValues[key] = value;
          }
        }

        // Store secrets in vault via config-cli
        for (const secret of secretsToStore) {
          try {
            await storeSecret(pluginName, secret.key, secret.value);
          } catch (vaultErr) {
            warn(
              `Failed to store secret "${secret.key}" in vault: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`,
            );
            warn('The value will be stored in the config file instead (not recommended).');
            configValues[secret.key] = secret.value;
          }
        }

        // Update opendawg.yaml
        if (!config.plugins[pluginName]) {
          config.plugins[pluginName] = { enabled: false, config: {} };
        }
        config.plugins[pluginName].config = configValues;

        await saveProjectConfig(config);

        success(`Plugin "${pluginName}" configured successfully.`);
        if (secretsToStore.length > 0) {
          info(`${secretsToStore.length} secret(s) stored in vault.`);
        }
      } catch (err) {
        error(`Configure failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Configure the top-level server section (port, hostname).
 */
async function configureServer(opts: { kv?: string[] }, cmd: Command): Promise<void> {
  const config = loadConfig();
  const existing = getServerConfig(config) as Record<string, any>;

  let newValues: Record<string, any>;

  // Parse --key=value pairs
  const rawPairs: string[] = [...(opts.kv ?? [])];
  const rawArgs = cmd.args ?? [];
  for (const arg of rawArgs) {
    if (arg.startsWith('--') && arg.includes('=')) {
      rawPairs.push(arg.slice(2));
    }
  }

  if (rawPairs.length > 0) {
    info('Configuring server (non-interactive)...');

    const parsed: Record<string, any> = {};
    for (const pair of rawPairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        error(`Invalid key=value pair: "${pair}". Expected format: key=value`);
        process.exitCode = 1;
        return;
      }
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);

      if (!(key in SERVER_SCHEMA)) {
        warn(`Unknown server config key "${key}". Skipping.`);
        continue;
      }

      const fieldSchema = SERVER_SCHEMA[key];
      if (fieldSchema.type === 'integer') {
        const num = parseInt(val, 10);
        if (Number.isNaN(num)) {
          error(`Invalid integer for key "${key}": ${val}`);
          process.exitCode = 1;
          return;
        }
        parsed[key] = num;
      } else {
        parsed[key] = val;
      }
    }

    newValues = { ...existing, ...parsed };
  } else {
    info('Configuring server interactively...');
    newValues = await promptForConfig(SERVER_SCHEMA, existing);
  }

  // Apply defaults and validate
  newValues = applyDefaults(newValues, SERVER_SCHEMA);
  const validationErrors = validateConfig(newValues, SERVER_SCHEMA);
  if (validationErrors.length > 0) {
    error('Server configuration validation failed:');
    for (const e of validationErrors) {
      error(`  - ${e.field}: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }

  config.server = { port: newValues.port, hostname: newValues.hostname, yolo: newValues.yolo };
  await saveProjectConfig(config);
  success('Server configured successfully.');
  info(`  port:     ${config.server.port}`);
  info(`  hostname: ${config.server.hostname}`);
  info(`  yolo:     ${config.server.yolo ?? false}`);
}
