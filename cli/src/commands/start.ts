import type { Command } from 'commander';
import {
  discoverPlugins,
  resolveStartOrder,
  checkSystemDeps,
  findPlugin,
  type PluginInfo,
} from '../lib/plugin-manager.js';
import { loadConfig, resolveVaultRefs } from '../lib/config.js';
import {
  collectComposeFiles,
  buildComposeCommand,
  runCompose,
} from '../lib/docker-compose.js';
import { startNativePlugin, isPluginRunning } from '../lib/process-manager.js';
import { info, success, warn, error, table } from '../utils/logger.js';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

/**
 * Parse a plugin's docker-compose.yml and extract all ${VAR_NAME} environment
 * variable references (stripping :-default suffixes).
 */
function extractComposeEnvVars(plugin: PluginInfo): string[] {
  const composePath =
    plugin.manifest.execution?.docker?.compose ??
    (plugin.manifest as any).docker?.compose_file;
  if (!composePath) return [];

  const fullPath = resolve(plugin.path, composePath);
  if (!existsSync(fullPath)) return [];

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const varPattern = /\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g;
    const vars = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = varPattern.exec(content)) !== null) {
      vars.add(match[1]);
    }
    return [...vars];
  } catch {
    return [];
  }
}

/**
 * Match an opendawg.yaml config key (e.g. "bot_token", "neo4j_password") to
 * the env var name that the plugin's docker-compose.yml expects.
 *
 * Strategy:
 *   1. Exact match: KEY uppercased matches an env var exactly → use it
 *   2. Suffix match: an env var ends with _KEY uppercased → use it
 *   3. Fallback: PLUGIN_NAME_KEY uppercased (the old prefix behavior)
 */
function matchConfigKeyToEnvVar(
  configKey: string,
  composeEnvVars: string[],
  pluginName: string,
): string {
  const keyUpper = configKey.toUpperCase();

  // 1. Exact match (e.g. config key "neo4j_password" → env var "NEO4J_PASSWORD")
  const exact = composeEnvVars.find((v) => v === keyUpper);
  if (exact) return exact;

  // 2. Suffix match (e.g. config key "bot_token" → env var "CHANNEL_TELEGRAM_BOT_TOKEN" or "PLUGIN_BOT_TOKEN")
  const suffixMatches = composeEnvVars.filter((v) => v.endsWith('_' + keyUpper));
  if (suffixMatches.length === 1) return suffixMatches[0];

  // If multiple suffix matches, prefer the one with the plugin name prefix
  if (suffixMatches.length > 1) {
    const pluginPrefix = pluginName.toUpperCase().replace(/-/g, '_');
    const prefixed = suffixMatches.find((v) => v.startsWith(pluginPrefix + '_'));
    if (prefixed) return prefixed;
    return suffixMatches[0]; // take first if no plugin-prefixed match
  }

  // 3. Special case: config key "port" — look for common patterns like
  //    GRAPHITI_PORT, CONFIG_CLI_PORT, etc.
  if (keyUpper === 'PORT') {
    // Look for any env var ending with _PORT that might be the main port
    const portVars = composeEnvVars.filter((v) => v.endsWith('_PORT') && !v.includes('BOLT') && !v.includes('HTTP'));
    if (portVars.length === 1) return portVars[0];
  }

  // 4. Fallback: prefix with plugin name (old behavior)
  return `${pluginName.toUpperCase().replace(/-/g, '_')}_${keyUpper}`;
}

/**
 * Wait for a plugin's health check to pass with retries.
 */
async function waitForHealthy(
  plugin: PluginInfo,
  maxRetries = 15,
  intervalMs = 2000,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const running = await isPluginRunning(plugin);
    if (running) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Hydrate plugin state from the config object.
 */
function hydratePluginState(
  plugins: PluginInfo[],
  config: ReturnType<typeof loadConfig>,
): void {
  for (const plugin of plugins) {
    const pluginCfg = config.plugins[plugin.name];
    if (pluginCfg) {
      plugin.state.enabled = pluginCfg.enabled;
      plugin.state.executionMode =
        pluginCfg.execution_mode ?? plugin.manifest.execution?.default ?? null;
    }
  }
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start plugins (all enabled or specific ones)')
    .argument('[plugins...]', 'Plugin names to start (default: all enabled)')
    .option('-a, --all', 'Start all enabled plugins')
    .action(async (pluginNames: string[], opts: { all?: boolean }) => {
      try {
        const allPlugins = await discoverPlugins(PLUGINS_DIR);
        const config = loadConfig();

        // Hydrate all plugin states from config
        hydratePluginState(allPlugins, config);

        // Determine which plugins to start
        let pluginsToStart: PluginInfo[];

        if (pluginNames.length > 0) {
          // Specific plugins requested — validate they exist
          const requested: PluginInfo[] = [];
          for (const name of pluginNames) {
            const plugin = findPlugin(allPlugins, name);
            if (!plugin) {
              error(`Plugin "${name}" not found. Run 'opendawg list' to see available plugins.`);
              process.exitCode = 1;
              return;
            }
            requested.push(plugin);
          }

          // Resolve dependencies: collect transitive deps and include them
          const depNames = new Set<string>();
          const collectDeps = (p: PluginInfo): void => {
            for (const depName of p.manifest.requires?.plugins ?? []) {
              if (!depNames.has(depName)) {
                depNames.add(depName);
                const dep = findPlugin(allPlugins, depName);
                if (dep) collectDeps(dep);
              }
            }
          };
          for (const p of requested) collectDeps(p);

          // Build full set: requested + their deps
          const fullSet = new Map<string, PluginInfo>();
          for (const depName of depNames) {
            const dep = findPlugin(allPlugins, depName);
            if (dep) fullSet.set(dep.name, dep);
          }
          for (const p of requested) {
            fullSet.set(p.name, p);
          }

          // Ensure all are marked enabled for this run
          for (const p of fullSet.values()) {
            p.state.enabled = true;
            if (!p.state.executionMode) {
              p.state.executionMode = p.manifest.execution?.default ?? null;
            }
          }

          pluginsToStart = resolveStartOrder([...fullSet.values()]);
        } else {
          // No args or --all: start all enabled plugins
          const enabledPlugins = allPlugins.filter((p) => p.state.enabled);

          if (enabledPlugins.length === 0) {
            info('No enabled plugins found. Enable plugins with "opendawg configure <plugin>" first.');
            return;
          }

          pluginsToStart = resolveStartOrder(enabledPlugins);
        }

        info(`Start order: ${pluginsToStart.map((p) => p.name).join(' -> ')}`);

        // Separate docker and native plugins, skip already-running ones
        const dockerPlugins: PluginInfo[] = [];
        const nativePlugins: PluginInfo[] = [];

        for (const plugin of pluginsToStart) {
          const running = await isPluginRunning(plugin);
          if (running) {
            info(`"${plugin.name}" is already running. Skipping.`);
            continue;
          }

          if (plugin.state.executionMode === 'docker') {
            dockerPlugins.push(plugin);
          } else {
            nativePlugins.push(plugin);
          }
        }

        // Start each docker plugin individually so failures are isolated
        for (const plugin of dockerPlugins) {
          info(`Starting docker plugin "${plugin.name}"...`);

          // Build env map from this plugin's config, resolving vault refs
          const env: Record<string, string> = {};
          const pluginCfg = config.plugins?.[plugin.name]?.config;
          if (pluginCfg) {
            let resolvedCfg: Record<string, any>;
            try {
              resolvedCfg = resolveVaultRefs(pluginCfg);
            } catch (vaultErr) {
              warn(`Vault resolution failed for "${plugin.name}": ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`);
              warn('Using raw config values (vault references will not be resolved).');
              resolvedCfg = pluginCfg;
            }

            // Extract env var names from the plugin's docker-compose.yml
            const composeEnvVars = extractComposeEnvVars(plugin);

            for (const [key, value] of Object.entries(resolvedCfg)) {
              if (value === undefined || value === null) continue;
              const envVarName = matchConfigKeyToEnvVar(key, composeEnvVars, plugin.name);
              env[envVarName] = String(value);
            }
          }

          const composeFiles = collectComposeFiles([plugin], PLUGINS_DIR);
          if (composeFiles.length === 0) {
            warn(`No compose file found for "${plugin.name}". Skipping.`);
            continue;
          }

          const cmd = buildComposeCommand(composeFiles, 'up', {
            projectName: 'opendawg',
            detach: true,
            env,
          });
          const result = await runCompose(cmd, { env });

          if (result.exitCode !== 0) {
            error(`Failed to start "${plugin.name}" (exit ${result.exitCode}):`);
            if (result.stderr) error(result.stderr.trim());
          } else {
            success(`"${plugin.name}" compose services started.`);
          }
        }

        // Start native plugins sequentially in dependency order
        for (const plugin of nativePlugins) {
          // Skip skill-only plugins that have no native start command —
          // they are loaded on-demand by the AI agent, not run as daemons
          const startCmd = plugin.manifest.execution?.native?.start;
          if (!startCmd) {
            info(`"${plugin.name}" is a skill plugin (no daemon). Skipping.`);
            // Remove from pluginsToStart so health check doesn't wait for it
            const idx = pluginsToStart.indexOf(plugin);
            if (idx !== -1) pluginsToStart.splice(idx, 1);
            continue;
          }

          info(`Starting native plugin "${plugin.name}"...`);

          // Check system deps first
          const depResult = checkSystemDeps(plugin.manifest);
          if (!depResult.satisfied) {
            error(`Cannot start "${plugin.name}" — missing system dependencies:`);
            for (const dep of depResult.missing) {
              error(`  - ${dep}`);
            }
            continue;
          }

          try {
            await startNativePlugin(plugin);
            success(`"${plugin.name}" started.`);
          } catch (startErr) {
            error(
              `Failed to start "${plugin.name}": ${startErr instanceof Error ? startErr.message : String(startErr)}`,
            );
          }
        }

        // Wait for health checks and report final status
        info('Waiting for health checks...');
        const results: Array<{ name: string; status: string }> = [];

        for (const plugin of pluginsToStart) {
          const healthy = await waitForHealthy(plugin, 30, 2000);
          results.push({ name: plugin.name, status: healthy ? 'healthy' : 'unhealthy' });

          if (!healthy) {
            warn(`"${plugin.name}" did not pass health check within timeout.`);
          }
        }

        // Report status table
        table(
          ['Plugin', 'Status'],
          results.map((r) => [r.name, r.status === 'healthy' ? 'running' : r.status]),
        );

        const failedCount = results.filter((r) => r.status !== 'healthy').length;
        if (failedCount > 0) {
          warn(`${failedCount} plugin(s) failed health check. Check logs for details.`);
        } else {
          success('All plugins started successfully.');
        }
      } catch (err) {
        error(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
