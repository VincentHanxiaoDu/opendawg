import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PluginInfo {
  /** The plugin name from the manifest */
  name: string;
  /** Absolute path to the plugin directory */
  path: string;
  /** Parsed manifest */
  manifest: PluginManifest;
  /** Runtime state (populated later by consumers) */
  state: PluginState;
}

export interface PluginState {
  enabled: boolean;
  running: boolean;
  executionMode: 'docker' | 'native' | null;
  healthy: boolean | null;
}

export interface SystemDepResult {
  satisfied: boolean;
  missing: string[];
  details: Record<string, { found: boolean; version?: string }>;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a plugins directory and parse each sub-directory that contains a
 * plugin.yaml. Directories without a manifest are silently skipped.
 */
export async function discoverPlugins(pluginsDir: string): Promise<PluginInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    return [];
  }

  const plugins: PluginInfo[] = [];

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);

    // Only consider directories
    try {
      const s = await stat(pluginDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const manifest = await parseManifest(pluginDir);
      plugins.push({
        name: manifest.name,
        path: pluginDir,
        manifest,
        state: {
          enabled: false,
          running: false,
          executionMode: null,
          healthy: null,
        },
      });
    } catch {
      // Skip directories that don't have a valid plugin manifest
    }
  }

  return plugins;
}

/**
 * Return plugins in topological start order: dependencies first.
 * Throws if there's a circular dependency.
 */
export function resolveStartOrder(plugins: PluginInfo[]): PluginInfo[] {
  return topologicalSort(plugins);
}

/**
 * Return plugins in reverse topological order: dependents first, then dependencies.
 * This is the safe order for shutting down.
 */
export function resolveStopOrder(plugins: PluginInfo[]): PluginInfo[] {
  return topologicalSort(plugins).reverse();
}

/**
 * Check whether the system dependencies listed in a plugin manifest
 * are available on this machine.
 */
export function checkSystemDeps(manifest: PluginManifest): SystemDepResult {
  const required = manifest.requires?.system ?? [];
  const missing: string[] = [];
  const details: Record<string, { found: boolean; version?: string }> = {};

  for (const dep of required) {
    const info = checkBinary(dep);
    details[dep] = info;
    if (!info.found) {
      missing.push(dep);
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
    details,
  };
}

/**
 * Convenience: check system deps for all execution modes a plugin might use.
 * Docker-mode plugins implicitly require `docker`.
 * Native-mode plugins check the plugin's own system deps.
 */
export function checkPluginDeps(plugin: PluginInfo, mode: 'docker' | 'native'): SystemDepResult {
  const systemDeps = [...(plugin.manifest.requires?.system ?? [])];

  if (mode === 'docker' && !systemDeps.includes('docker')) {
    systemDeps.unshift('docker');
  }

  // Build a synthetic manifest just for the check
  const syntheticManifest: PluginManifest = {
    ...plugin.manifest,
    requires: {
      ...plugin.manifest.requires,
      system: systemDeps,
    },
  };

  return checkSystemDeps(syntheticManifest);
}

/**
 * Look up a plugin by name from a list.
 */
export function findPlugin(plugins: PluginInfo[], name: string): PluginInfo | undefined {
  return plugins.find((p) => p.name === name);
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Kahn's algorithm for topological sort.
 */
function topologicalSort(plugins: PluginInfo[]): PluginInfo[] {
  const byName = new Map<string, PluginInfo>();
  for (const p of plugins) {
    byName.set(p.name, p);
  }

  // Build adjacency list and in-degree map
  // Edge: dependency → dependent (dependency must come first)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → [plugins that depend on it]

  for (const p of plugins) {
    if (!inDegree.has(p.name)) inDegree.set(p.name, 0);
    if (!dependents.has(p.name)) dependents.set(p.name, []);

    const deps = p.manifest.requires?.plugins ?? [];
    for (const dep of deps) {
      // Only count dependencies that are in our plugin set
      if (!byName.has(dep)) continue;

      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(p.name);
    }
  }

  // Collect nodes with in-degree 0
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  // Sort the initial queue for deterministic ordering
  queue.sort();

  const sorted: PluginInfo[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(byName.get(current)!);

    for (const dependent of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        // Insert into queue in sorted position for determinism
        const insertIdx = queue.findIndex((q) => q > dependent);
        if (insertIdx === -1) {
          queue.push(dependent);
        } else {
          queue.splice(insertIdx, 0, dependent);
        }
      }
    }
  }

  if (sorted.length !== plugins.length) {
    const remaining = plugins.filter((p) => !sorted.some((s) => s.name === p.name));
    const names = remaining.map((p) => p.name).join(', ');
    throw new Error(`Circular dependency detected among plugins: ${names}`);
  }

  return sorted;
}

/**
 * Check if a binary is available on the system and optionally get its version.
 */
function checkBinary(name: string): { found: boolean; version?: string } {
  try {
    // Use `which` to check existence
    execFileSync('which', [name], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    });
  } catch {
    return { found: false };
  }

  // Try to get version
  const versionFlags = ['--version', '-v', 'version'];
  for (const flag of versionFlags) {
    try {
      const output = execFileSync(name, [flag], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000,
      });
      // Extract first line that looks like a version
      const versionMatch = output.match(/\d+\.\d+[\w.-]*/);
      if (versionMatch) {
        return { found: true, version: versionMatch[0] };
      }
    } catch {
      // try next flag
    }
  }

  return { found: true };
}
