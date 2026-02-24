import type { Command } from 'commander';
import { discoverPlugins, checkSystemDeps } from '../lib/plugin-manager.js';
import { validateManifest } from '../lib/plugin-manifest.js';
import { loadConfig, saveProjectConfig } from '../lib/config.js';
import { info, success, warn, error } from '../utils/logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const PLUGINS_DIR = resolve(process.cwd(), 'plugins');

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install a plugin by name')
    .argument('<plugin>', 'Plugin name to install')
    .action(async (pluginName: string) => {
      try {
        // Discover available plugins
        const plugins = await discoverPlugins(PLUGINS_DIR);
        const plugin = plugins.find((p) => p.manifest.name === pluginName);

        if (!plugin) {
          error(`Plugin "${pluginName}" not found. Run 'opendawg list' to see available plugins.`);
          process.exitCode = 1;
          return;
        }

        // Validate the plugin manifest
        info(`Validating manifest for "${pluginName}"...`);
        const manifest = plugin.manifest;
        const validation = validateManifest(manifest);
        if (!validation.valid) {
          error(`Invalid manifest for "${pluginName}":`);
          for (const e of validation.errors) {
            error(`  - ${e}`);
          }
          process.exitCode = 1;
          return;
        }

        // Check system dependencies
        info('Checking system dependencies...');
        const depResult = checkSystemDeps(manifest);
        if (!depResult.satisfied) {
          error('Missing system dependencies:');
          for (const dep of depResult.missing) {
            error(`  - ${dep}`);
          }
          process.exitCode = 1;
          return;
        }

        // Run post_install hook if defined
        if (manifest.hooks?.post_install) {
          info(`Running post-install hook: ${manifest.hooks.post_install}`);
          try {
            const hookScript = manifest.hooks.post_install;
            const cwd = plugin.path;
            await execFileAsync('sh', ['-c', hookScript], { cwd });
            success('Post-install hook completed.');
          } catch (hookErr) {
            warn(
              `Post-install hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
            );
            warn('The plugin was still added but the hook did not complete successfully.');
          }
        }

        // Add the plugin to opendawg.yaml as enabled: false
        const config = loadConfig();

        if (config.plugins[pluginName]) {
          warn(`Plugin "${pluginName}" is already installed. Config entry unchanged.`);
        } else {
          config.plugins[pluginName] = { enabled: false, config: {} };
          await saveProjectConfig(config);
          success(`Plugin "${pluginName}" installed (disabled by default).`);
          info(`Run 'opendawg configure ${pluginName}' to configure, then 'opendawg start ${pluginName}' to enable.`);
        }
      } catch (err) {
        error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
