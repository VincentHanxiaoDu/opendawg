import type { Command } from 'commander';
import { discoverPlugins, findPlugin } from '../lib/plugin-manager.js';
import { loadConfig, saveProjectConfig } from '../lib/config.js';
import { isPluginRunning, stopNativePlugin } from '../lib/process-manager.js';
import { collectComposeFiles, buildComposeCommand, runCompose } from '../lib/docker-compose.js';
import { info, success, warn, error } from '../utils/logger.js';
import { promptConfirm } from '../utils/prompts.js';
import { resolve } from 'node:path';

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Uninstall a plugin by name')
    .argument('<plugin>', 'Plugin name to uninstall')
    .option('-f, --force', 'Force uninstall even if other plugins depend on it')
    .action(async (pluginName: string, opts: { force?: boolean }) => {
      try {
        const config = loadConfig();
        const plugins = await discoverPlugins(PLUGINS_DIR);

        // Check the plugin exists in the config
        if (!config.plugins[pluginName]) {
          error(`Plugin "${pluginName}" is not installed. Run 'opendawg list' to see available plugins.`);
          process.exitCode = 1;
          return;
        }

        // Check for dependents — other enabled plugins that depend on this one
        const dependents: string[] = [];
        for (const p of plugins) {
          const deps = p.manifest.requires?.plugins ?? [];
          if (deps.includes(pluginName) && config.plugins[p.manifest.name]?.enabled) {
            dependents.push(p.manifest.name);
          }
        }

        if (dependents.length > 0 && !opts.force) {
          warn(`The following enabled plugins depend on "${pluginName}": ${dependents.join(', ')}`);
          const proceed = await promptConfirm(
            'Uninstalling may break these plugins. Continue?',
            false,
          );
          if (!proceed) {
            info('Uninstall cancelled.');
            return;
          }
        }

        // Stop the plugin if it is currently running
        const plugin = findPlugin(plugins, pluginName);
        if (plugin) {
          // Hydrate state from config
          const pluginCfg = config.plugins[pluginName];
          plugin.state.enabled = pluginCfg.enabled;
          plugin.state.executionMode = pluginCfg.execution_mode ?? plugin.manifest.execution?.default ?? null;

          const running = await isPluginRunning(plugin);
          if (running) {
            info(`Stopping "${pluginName}" before uninstall...`);
            if (plugin.state.executionMode === 'docker') {
              const composeFiles = collectComposeFiles([plugin], PLUGINS_DIR);
              if (composeFiles.length > 0) {
                const cmd = buildComposeCommand(composeFiles, 'down');
                await runCompose(cmd);
              }
            } else {
              await stopNativePlugin(plugin);
            }
            success(`"${pluginName}" stopped.`);
          }
        }

        // Remove from opendawg.yaml
        delete config.plugins[pluginName];
        await saveProjectConfig(config);

        success(`Plugin "${pluginName}" uninstalled and removed from configuration.`);
      } catch (err) {
        error(`Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
