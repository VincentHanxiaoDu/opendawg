import type { Command } from 'commander';
import { discoverPlugins, findPlugin, type PluginInfo } from '../lib/plugin-manager.js';
import { loadConfig, getPluginConfig } from '../lib/config.js';
import { maskSecrets } from '../lib/schema-validator.js';
import { isPluginRunning } from '../lib/process-manager.js';
import { info, error, table } from '../utils/logger.js';
import chalk from 'chalk';
import { resolve } from 'node:path';

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

/**
 * Hydrate a single plugin's state from the config.
 */
function hydratePlugin(plugin: PluginInfo, config: ReturnType<typeof loadConfig>): void {
  const pluginCfg = config.plugins[plugin.name];
  if (pluginCfg) {
    plugin.state.enabled = pluginCfg.enabled;
    plugin.state.executionMode =
      pluginCfg.execution_mode ?? plugin.manifest.execution?.default ?? null;
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show status of plugins')
    .argument('[plugin]', 'Plugin name for detailed view')
    .action(async (pluginName?: string) => {
      try {
        const allPlugins = await discoverPlugins(PLUGINS_DIR);
        const config = loadConfig();

        // Hydrate state for all plugins
        for (const p of allPlugins) hydratePlugin(p, config);

        if (pluginName) {
          // Detailed view for a single plugin
          const plugin = findPlugin(allPlugins, pluginName);
          if (!plugin) {
            error(`Plugin "${pluginName}" not found. Run 'opendawg list' to see available plugins.`);
            process.exitCode = 1;
            return;
          }

          const manifest = plugin.manifest;
          const enabled = plugin.state.enabled;
          const running = enabled ? await isPluginRunning(plugin) : false;
          const mode = plugin.state.executionMode ?? manifest.execution?.default ?? 'unknown';

          console.log('');
          console.log(chalk.bold(`Plugin: ${pluginName}`));
          console.log(`  Version:      ${manifest.version ?? 'unknown'}`);
          console.log(`  Category:     ${manifest.category ?? 'unknown'}`);
          console.log(`  Mode:         ${mode}`);
          console.log(`  Enabled:      ${enabled ? chalk.green('yes') : chalk.gray('no')}`);
          console.log(
            `  Status:       ${running ? chalk.green('running') : enabled ? chalk.yellow('stopped') : chalk.gray('disabled')}`,
          );

          if (manifest.description) {
            console.log(`  Description:  ${manifest.description}`);
          }

          const pluginDeps = manifest.requires?.plugins ?? [];
          if (pluginDeps.length > 0) {
            console.log(`  Dependencies: ${pluginDeps.join(', ')}`);
          }

          // Show config with masked secrets
          const pluginCfg = getPluginConfig(config, pluginName);
          const rawConfig = pluginCfg.config;
          if (rawConfig && Object.keys(rawConfig).length > 0) {
            const schema = manifest.config?.schema ?? {};
            const masked = maskSecrets(rawConfig, schema);

            console.log('');
            console.log(chalk.bold('  Configuration:'));
            for (const [key, value] of Object.entries(masked)) {
              const displayValue = Array.isArray(value) ? value.join(', ') : String(value);
              console.log(`    ${key}: ${displayValue}`);
            }
          }

          // Health check info
          if (manifest.hooks?.health_check) {
            console.log('');
            console.log(chalk.bold('  Health check:'));
            console.log(`    Command: ${manifest.hooks.health_check}`);
          }

          // Execution info
          if (manifest.execution) {
            console.log('');
            console.log(chalk.bold('  Execution:'));
            console.log(`    Available modes: ${manifest.execution.modes.join(', ')}`);
            console.log(`    Default mode:    ${manifest.execution.default}`);
            if (manifest.execution.docker?.compose) {
              console.log(`    Compose file:    ${manifest.execution.docker.compose}`);
            }
            if (manifest.execution.native?.start) {
              console.log(`    Start command:   ${manifest.execution.native.start}`);
            }
            if (manifest.execution.native?.stop) {
              console.log(`    Stop command:    ${manifest.execution.native.stop}`);
            }
          }

          console.log('');
        } else {
          // Summary table of all enabled plugins
          const enabledPlugins = allPlugins.filter((p) => p.state.enabled);

          if (enabledPlugins.length === 0) {
            info('No enabled plugins. Use "opendawg install <plugin>" and "opendawg configure <plugin>" to get started.');
            return;
          }

          const rows: string[][] = [];
          for (const plugin of enabledPlugins) {
            const running = await isPluginRunning(plugin);
            const mode = plugin.state.executionMode ?? plugin.manifest.execution?.default ?? 'unknown';
            plugin.state.running = running;

            rows.push([
              plugin.name,
              mode,
              running ? chalk.green('running') : chalk.yellow('stopped'),
            ]);
          }

          table(['Plugin', 'Mode', 'Status'], rows);
        }
      } catch (err) {
        error(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
