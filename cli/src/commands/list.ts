import type { Command } from 'commander';
import { discoverPlugins, type PluginInfo } from '../lib/plugin-manager.js';
import { loadConfig } from '../lib/config.js';
import { isPluginRunning } from '../lib/process-manager.js';
import { info, error, table } from '../utils/logger.js';
import { resolve } from 'node:path';

const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all discovered plugins')
    .option('-c, --category <category>', 'Filter by category (e.g. core, channel, skill)')
    .option('-j, --json', 'Output as JSON instead of a table')
    .action(async (opts: { category?: string; json?: boolean }) => {
      try {
        const plugins = await discoverPlugins(PLUGINS_DIR);
        const config = loadConfig();

        let filtered = plugins;
        if (opts.category) {
          const cat = opts.category.toLowerCase();
          filtered = plugins.filter(
            (p) => p.manifest.category?.toLowerCase() === cat,
          );
        }

        const rows: Array<{
          name: string;
          category: string;
          version: string;
          enabled: boolean;
          status: string;
        }> = [];

        for (const plugin of filtered) {
          const name = plugin.manifest.name;
          const pluginConfig = config.plugins[name];
          const enabled = pluginConfig?.enabled ?? false;

          // Hydrate state so isPluginRunning can use it
          plugin.state.enabled = enabled;
          plugin.state.executionMode = pluginConfig?.execution_mode ?? plugin.manifest.execution?.default ?? null;

          let status: string;
          if (!enabled) {
            status = 'disabled';
          } else {
            const running = await isPluginRunning(plugin);
            status = running ? 'running' : 'stopped';
          }

          rows.push({
            name,
            category: plugin.manifest.category ?? 'unknown',
            version: plugin.manifest.version ?? '0.0.0',
            enabled,
            status,
          });
        }

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          info('No plugins found' + (opts.category ? ` for category "${opts.category}"` : '') + '.');
          return;
        }

        table(
          ['Name', 'Category', 'Version', 'Enabled', 'Status'],
          rows.map((r) => [
            r.name,
            r.category,
            r.version,
            r.enabled ? 'yes' : 'no',
            r.status,
          ]),
        );
      } catch (err) {
        error(`Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
