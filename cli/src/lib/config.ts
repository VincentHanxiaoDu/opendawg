import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PluginConfig {
  enabled: boolean;
  execution_mode?: 'docker' | 'native';
  config: Record<string, any>;
}

export interface OpendawgConfig {
  plugins: Record<string, PluginConfig>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = join(homedir(), '.opendawg');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.yaml');
const PROJECT_CONFIG_FILE = 'opendawg.yaml';
const ENV_PREFIX = 'OPENDAWG_';
const VAULT_REF_PATTERN = /\$\{vault:([^}]+)\}/g;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the merged opendawg configuration.
 *
 * Precedence (highest wins):
 *   1. Environment variables (OPENDAWG_PLUGIN_<NAME>_<KEY>)
 *   2. Project-local ./opendawg.yaml
 *   3. Global ~/.opendawg/config.yaml
 *
 * Missing config files are silently treated as empty.
 */
export function loadConfig(projectDir?: string): OpendawgConfig {
  const globalConfig = loadYamlFileSync(GLOBAL_CONFIG_FILE);
  const projectPath = resolve(projectDir ?? process.cwd(), PROJECT_CONFIG_FILE);
  const projectConfig = loadYamlFileSync(projectPath);

  // Start from an empty config, merge global, then project
  let merged = emptyConfig();
  merged = mergeConfigs(merged, normalizeRawConfig(globalConfig));
  merged = mergeConfigs(merged, normalizeRawConfig(projectConfig));

  // Apply environment variable overrides
  merged = applyEnvOverrides(merged);

  return merged;
}

/**
 * Write the project-local opendawg.yaml.
 */
export async function saveProjectConfig(
  config: OpendawgConfig,
  projectDir?: string,
): Promise<void> {
  const dir = resolve(projectDir ?? process.cwd());
  const filePath = join(dir, PROJECT_CONFIG_FILE);
  const content = stringifyYaml(config, { indent: 2, lineWidth: 120 });
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Save to the global ~/.opendawg/config.yaml.
 */
export async function saveGlobalConfig(config: OpendawgConfig): Promise<void> {
  await mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
  const content = stringifyYaml(config, { indent: 2, lineWidth: 120 });
  await writeFile(GLOBAL_CONFIG_FILE, content, 'utf-8');
}

/**
 * Recursively resolve `${vault:key}` references in a config object
 * by invoking `config-cli get <key>`.
 * Returns a deep copy with all vault refs replaced by their resolved values.
 */
export function resolveVaultRefs(config: any): any {
  if (typeof config === 'string') {
    return config.replace(VAULT_REF_PATTERN, (_match, key: string) => {
      return readVaultKey(key.trim());
    });
  }

  if (Array.isArray(config)) {
    return config.map((item) => resolveVaultRefs(item));
  }

  if (typeof config === 'object' && config !== null) {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(config)) {
      result[k] = resolveVaultRefs(v);
    }
    return result;
  }

  return config;
}

/**
 * Get the config block for a specific plugin, returning a sensible default
 * if the plugin isn't mentioned in the config at all.
 */
export function getPluginConfig(config: OpendawgConfig, pluginName: string): PluginConfig {
  return (
    config.plugins[pluginName] ?? {
      enabled: false,
      config: {},
    }
  );
}

/**
 * Return path constants for external consumers.
 */
export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR;
}

export function getGlobalConfigFile(): string {
  return GLOBAL_CONFIG_FILE;
}

// ── Internals ────────────────────────────────────────────────────────────────

function emptyConfig(): OpendawgConfig {
  return { plugins: {} };
}

/**
 * Synchronously read and parse a YAML file. Returns an empty object if the
 * file doesn't exist or can't be parsed.
 */
function loadYamlFileSync(filePath: string): Record<string, any> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = fsReadFileSync(filePath, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, any>;
  } catch {
    return {};
  }
}

/**
 * Normalize a raw YAML config object into OpendawgConfig shape.
 */
function normalizeRawConfig(raw: Record<string, any>): OpendawgConfig {
  const config = emptyConfig();

  if (raw.plugins && typeof raw.plugins === 'object') {
    for (const [name, pluginRaw] of Object.entries(raw.plugins)) {
      const p = pluginRaw as any;
      config.plugins[name] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
        execution_mode: p.execution_mode,
        config: typeof p.config === 'object' && p.config !== null ? p.config : {},
      };
    }
  }

  return config;
}

/**
 * Deep-merge two OpendawgConfig objects. `override` takes precedence.
 */
function mergeConfigs(base: OpendawgConfig, override: OpendawgConfig): OpendawgConfig {
  const merged = emptyConfig();

  // Combine all plugin names from both
  const allPlugins = new Set([...Object.keys(base.plugins), ...Object.keys(override.plugins)]);

  for (const name of allPlugins) {
    const basePlugin = base.plugins[name];
    const overridePlugin = override.plugins[name];

    if (!basePlugin) {
      merged.plugins[name] = { ...overridePlugin! };
    } else if (!overridePlugin) {
      merged.plugins[name] = { ...basePlugin };
    } else {
      merged.plugins[name] = {
        enabled: overridePlugin.enabled,
        execution_mode: overridePlugin.execution_mode ?? basePlugin.execution_mode,
        config: { ...basePlugin.config, ...overridePlugin.config },
      };
    }
  }

  return merged;
}

/**
 * Apply env var overrides. Pattern:
 *   OPENDAWG_PLUGIN_<PLUGIN_NAME>_<KEY>=<value>
 *
 * Plugin name is uppercased, hyphens replaced with underscores.
 * e.g. OPENDAWG_PLUGIN_GRAPHITI_MEMORY_NEO4J_URI=bolt://localhost:7687
 *      → plugins["graphiti-memory"].config["neo4j_uri"] = "bolt://localhost:7687"
 *
 * Special keys:
 *   OPENDAWG_PLUGIN_<NAME>_ENABLED=true/false
 *   OPENDAWG_PLUGIN_<NAME>_EXECUTION_MODE=docker/native
 */
function applyEnvOverrides(config: OpendawgConfig): OpendawgConfig {
  const pluginPrefix = `${ENV_PREFIX}PLUGIN_`;

  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith(pluginPrefix) || envValue === undefined) continue;

    const rest = envKey.slice(pluginPrefix.length); // e.g. GRAPHITI_MEMORY_NEO4J_URI
    // We need to figure out which part is the plugin name and which is the config key.
    // Strategy: try progressively longer plugin name prefixes against known plugins.
    const matched = matchPluginEnvKey(rest, config);
    if (!matched) continue;

    const { pluginName, configKey } = matched;

    if (!config.plugins[pluginName]) {
      config.plugins[pluginName] = { enabled: true, config: {} };
    }

    if (configKey === 'ENABLED') {
      config.plugins[pluginName].enabled = envValue.toLowerCase() === 'true' || envValue === '1';
    } else if (configKey === 'EXECUTION_MODE') {
      if (envValue === 'docker' || envValue === 'native') {
        config.plugins[pluginName].execution_mode = envValue;
      }
    } else {
      config.plugins[pluginName].config[configKey.toLowerCase()] = envValue;
    }
  }

  return config;
}

/**
 * Try to match an env key suffix against known plugin names.
 * Returns the plugin name and remaining config key, or null if no match.
 */
function matchPluginEnvKey(
  envKeySuffix: string,
  config: OpendawgConfig,
): { pluginName: string; configKey: string } | null {
  // Build a lookup: uppercased-env-name → original plugin name
  const pluginNames = Object.keys(config.plugins);
  const lookup = new Map<string, string>();
  for (const name of pluginNames) {
    const envName = name.toUpperCase().replace(/-/g, '_');
    lookup.set(envName, name);
  }

  // Try longest prefix first to handle plugins whose names are prefixes of other plugins
  const sortedEnvNames = [...lookup.keys()].sort((a, b) => b.length - a.length);

  for (const envName of sortedEnvNames) {
    if (envKeySuffix.startsWith(envName + '_')) {
      const configKey = envKeySuffix.slice(envName.length + 1);
      if (configKey.length > 0) {
        return { pluginName: lookup.get(envName)!, configKey };
      }
    }
  }

  // If no known plugin matched, try the first underscore-segment as the plugin name
  const firstUnderscore = envKeySuffix.indexOf('_');
  if (firstUnderscore > 0) {
    const pluginName = envKeySuffix.slice(0, firstUnderscore).toLowerCase().replace(/_/g, '-');
    const configKey = envKeySuffix.slice(firstUnderscore + 1);
    return { pluginName, configKey };
  }

  return null;
}

/**
 * Read a single value from the config-cli vault.
 */
function readVaultKey(key: string): string {
  try {
    const result = execFileSync('config-cli', ['get', key], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    throw new Error(`Failed to resolve vault reference "${key}": ${(err as Error).message}`);
  }
}
