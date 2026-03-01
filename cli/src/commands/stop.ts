import type { Command } from 'commander';
import {
  discoverPlugins,
  resolveStopOrder,
  findPlugin,
  type PluginInfo,
} from '../lib/plugin-manager.js';
import { loadConfig } from '../lib/config.js';
import {
  collectComposeFiles,
  buildComposeCommand,
  runCompose,
} from '../lib/docker-compose.js';
import { stopNativePlugin, isPluginRunning } from '../lib/process-manager.js';
import { info, success, warn, error } from '../utils/logger.js';
import { resolve } from 'node:path';

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

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

export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop plugins (all running or specific ones)')
    .argument('[plugins...]', 'Plugin names to stop (default: all running)')
    .option('-a, --all', 'Stop all running plugins')
    .action(async (pluginNames: string[], opts: { all?: boolean }) => {
      try {
        const allPlugins = await discoverPlugins(PLUGINS_DIR);
        const config = loadConfig();

        // Hydrate all plugin states from config
        hydratePluginState(allPlugins, config);

        // Determine which plugins to stop
        let pluginsToStop: PluginInfo[];

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

          // Also collect dependents (plugins that depend on the ones being stopped)
          const toStopNames = new Set(requested.map((p) => p.name));
          const collectDependents = (targetName: string): void => {
            for (const p of allPlugins) {
              if (toStopNames.has(p.name)) continue;
              const deps = p.manifest.requires?.plugins ?? [];
              if (deps.includes(targetName) && p.state.enabled) {
                toStopNames.add(p.name);
                collectDependents(p.name);
              }
            }
          };
          for (const p of requested) collectDependents(p.name);

          const fullSet = allPlugins.filter((p) => toStopNames.has(p.name));
          pluginsToStop = resolveStopOrder(fullSet);
        } else {
          // No args or --all: stop all running plugins
          const runningPlugins: PluginInfo[] = [];
          for (const plugin of allPlugins) {
            const running = await isPluginRunning(plugin);
            if (running) {
              runningPlugins.push(plugin);
            }
          }

          if (runningPlugins.length === 0) {
            info('No plugins are currently running.');
            return;
          }

          pluginsToStop = resolveStopOrder(runningPlugins);
        }

        info(`Stop order: ${pluginsToStop.map((p) => p.name).join(' -> ')}`);

        // Separate docker and native plugins, skip non-running ones
        const dockerPlugins: PluginInfo[] = [];
        const nativePlugins: PluginInfo[] = [];

        for (const plugin of pluginsToStop) {
          const running = await isPluginRunning(plugin);
          if (!running) {
            info(`"${plugin.name}" is not running. Skipping.`);
            continue;
          }

          if (plugin.state.executionMode === 'docker') {
            dockerPlugins.push(plugin);
          } else {
            nativePlugins.push(plugin);
          }
        }

        // Stop native plugins first (they may depend on docker services)
        for (const plugin of nativePlugins) {
          info(`Stopping native plugin "${plugin.name}"...`);
          try {
            await stopNativePlugin(plugin);
            success(`"${plugin.name}" stopped.`);
          } catch (stopErr) {
            warn(`Failed to stop "${plugin.name}": ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
          }
        }

        // Stop docker plugins via compose down
        if (dockerPlugins.length > 0) {
          info(`Stopping docker plugins: ${dockerPlugins.map((p) => p.name).join(', ')}...`);
          try {
            const composeFiles = collectComposeFiles(dockerPlugins, PLUGINS_DIR);
            if (composeFiles.length > 0) {
              const cmd = buildComposeCommand(composeFiles, 'down', { projectName: 'opendawg', removeOrphans: true });
              const result = await runCompose(cmd);

              if (result.exitCode !== 0) {
                error(`Docker compose down failed (exit ${result.exitCode}):`);
                if (result.stderr) error(result.stderr);
              } else {
                for (const plugin of dockerPlugins) {
                  success(`"${plugin.name}" compose services stopped.`);
                }
              }
            }
          } catch (composeErr) {
            error(
              `Docker compose stop failed: ${composeErr instanceof Error ? composeErr.message : String(composeErr)}`,
            );
          }
        }

        success('Stop complete.');
      } catch (err) {
        error(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
