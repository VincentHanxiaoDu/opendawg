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

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

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

        // Start docker plugins via compose up with merged fragments
        if (dockerPlugins.length > 0) {
          info(`Starting docker plugins: ${dockerPlugins.map((p) => p.name).join(', ')}...`);

          // Resolve vault references so env vars are populated
          const resolvedConfig = resolveVaultRefs(config);

          // Build env map from resolved plugin configs
          const env: Record<string, string> = {};
          for (const plugin of dockerPlugins) {
            const pluginCfg = resolvedConfig.plugins?.[plugin.name]?.config;
            if (pluginCfg) {
              for (const [key, value] of Object.entries(pluginCfg)) {
                if (value !== undefined && value !== null) {
                  env[`${plugin.name.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase()}`] = String(value);
                }
              }
            }
          }

          const composeFiles = collectComposeFiles(dockerPlugins, PLUGINS_DIR);
          if (composeFiles.length > 0) {
            const cmd = buildComposeCommand(composeFiles, 'up', {
              projectName: 'opendawg',
              detach: true,
              env,
            });
            const result = await runCompose(cmd, { env });

            if (result.exitCode !== 0) {
              error(`Docker compose up failed (exit ${result.exitCode}):`);
              if (result.stderr) error(result.stderr);
            } else {
              for (const plugin of dockerPlugins) {
                success(`"${plugin.name}" compose services started.`);
              }
            }
          }
        }

        // Start native plugins sequentially in dependency order
        for (const plugin of nativePlugins) {
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
          const healthy = await waitForHealthy(plugin, 15, 2000);
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
