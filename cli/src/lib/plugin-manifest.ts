import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConfigFieldSchema {
  type: 'string' | 'integer' | 'boolean' | 'array';
  default?: any;
  secret?: boolean;
  required?: boolean;
  description?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  category: 'skill' | 'channel' | 'core';
  requires?: {
    plugins?: string[];
    system?: string[];
  };
  config?: {
    schema: Record<string, ConfigFieldSchema>;
  };
  execution?: {
    modes: ('docker' | 'native')[];
    default: 'docker' | 'native';
    docker?: {
      compose: string;
      profiles?: string[];
    };
    native?: {
      start: string;
      stop: string;
    };
  };
  hooks?: {
    post_install?: string;
    configure?: string;
    health_check?: string;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['skill', 'channel', 'core']);
const VALID_FIELD_TYPES = new Set(['string', 'integer', 'boolean', 'array']);
const VALID_EXEC_MODES = new Set(['docker', 'native']);

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read and parse a plugin.yaml (or plugin.yml) from the given plugin directory.
 * Throws if the file is missing or unparseable.
 */
export async function parseManifest(pluginDir: string): Promise<PluginManifest> {
  let raw: string | undefined;
  const candidates = ['plugin.yaml', 'plugin.yml'];

  for (const filename of candidates) {
    try {
      raw = await readFile(join(pluginDir, filename), 'utf-8');
      break;
    } catch {
      // try next candidate
    }
  }

  if (raw === undefined) {
    throw new Error(`No plugin.yaml or plugin.yml found in ${pluginDir}`);
  }

  const parsed = parseYaml(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML in ${pluginDir}: expected a mapping`);
  }

  const validation = validateManifest(parsed);
  if (!validation.valid) {
    throw new Error(
      `Invalid plugin manifest in ${pluginDir}:\n  - ${validation.errors.join('\n  - ')}`,
    );
  }

  return parsed as PluginManifest;
}

/**
 * Validate a raw parsed object against the PluginManifest schema.
 * Returns a list of all validation errors (empty means valid).
 */
export function validateManifest(manifest: any): ValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  // Required top-level string fields
  for (const field of ['name', 'version', 'description'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`"${field}" is required and must be a non-empty string`);
    }
  }

  // name format
  if (typeof manifest.name === 'string' && !/^[a-z0-9][a-z0-9_-]*$/.test(manifest.name)) {
    errors.push('"name" must be lowercase alphanumeric with hyphens/underscores, starting with a letter or digit');
  }

  // category
  if (!VALID_CATEGORIES.has(manifest.category)) {
    errors.push(`"category" must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
  }

  // requires (optional)
  if (manifest.requires !== undefined) {
    if (typeof manifest.requires !== 'object' || manifest.requires === null) {
      errors.push('"requires" must be an object');
    } else {
      if (manifest.requires.plugins !== undefined && !Array.isArray(manifest.requires.plugins)) {
        errors.push('"requires.plugins" must be an array of strings');
      } else if (manifest.requires.plugins) {
        for (const dep of manifest.requires.plugins) {
          if (typeof dep !== 'string') {
            errors.push(`Each entry in "requires.plugins" must be a string, got ${typeof dep}`);
          }
        }
      }
      if (manifest.requires.system !== undefined && !Array.isArray(manifest.requires.system)) {
        errors.push('"requires.system" must be an array of strings');
      } else if (manifest.requires.system) {
        for (const dep of manifest.requires.system) {
          if (typeof dep !== 'string') {
            errors.push(`Each entry in "requires.system" must be a string, got ${typeof dep}`);
          }
        }
      }
    }
  }

  // config (optional)
  if (manifest.config !== undefined) {
    if (typeof manifest.config !== 'object' || manifest.config === null) {
      errors.push('"config" must be an object');
    } else if (typeof manifest.config.schema !== 'object' || manifest.config.schema === null) {
      errors.push('"config.schema" must be an object mapping field names to schemas');
    } else {
      for (const [fieldName, fieldSchema] of Object.entries(manifest.config.schema)) {
        const fs = fieldSchema as any;
        if (typeof fs !== 'object' || fs === null) {
          errors.push(`config.schema["${fieldName}"] must be an object`);
          continue;
        }
        if (!VALID_FIELD_TYPES.has(fs.type)) {
          errors.push(
            `config.schema["${fieldName}"].type must be one of: ${[...VALID_FIELD_TYPES].join(', ')}`,
          );
        }
        if (fs.secret !== undefined && typeof fs.secret !== 'boolean') {
          errors.push(`config.schema["${fieldName}"].secret must be a boolean`);
        }
        if (fs.required !== undefined && typeof fs.required !== 'boolean') {
          errors.push(`config.schema["${fieldName}"].required must be a boolean`);
        }
        if (fs.description !== undefined && typeof fs.description !== 'string') {
          errors.push(`config.schema["${fieldName}"].description must be a string`);
        }
      }
    }
  }

  // execution (optional)
  if (manifest.execution !== undefined) {
    const exec = manifest.execution;
    if (typeof exec !== 'object' || exec === null) {
      errors.push('"execution" must be an object');
    } else {
      if (!Array.isArray(exec.modes) || exec.modes.length === 0) {
        errors.push('"execution.modes" must be a non-empty array');
      } else {
        for (const mode of exec.modes) {
          if (!VALID_EXEC_MODES.has(mode)) {
            errors.push(`Invalid execution mode: "${mode}". Must be one of: ${[...VALID_EXEC_MODES].join(', ')}`);
          }
        }
      }
      if (!VALID_EXEC_MODES.has(exec.default)) {
        errors.push(`"execution.default" must be one of: ${[...VALID_EXEC_MODES].join(', ')}`);
      }
      if (Array.isArray(exec.modes) && exec.default && !exec.modes.includes(exec.default)) {
        errors.push(`"execution.default" ("${exec.default}") must be listed in "execution.modes"`);
      }

      // docker block
      if (exec.docker !== undefined) {
        if (typeof exec.docker !== 'object' || exec.docker === null) {
          errors.push('"execution.docker" must be an object');
        } else if (typeof exec.docker.compose !== 'string' || exec.docker.compose.trim() === '') {
          errors.push('"execution.docker.compose" is required and must be a non-empty string');
        }
      }

      // native block
      if (exec.native !== undefined) {
        if (typeof exec.native !== 'object' || exec.native === null) {
          errors.push('"execution.native" must be an object');
        } else {
          if (typeof exec.native.start !== 'string' || exec.native.start.trim() === '') {
            errors.push('"execution.native.start" is required and must be a non-empty string');
          }
          if (typeof exec.native.stop !== 'string' || exec.native.stop.trim() === '') {
            errors.push('"execution.native.stop" is required and must be a non-empty string');
          }
        }
      }
    }
  }

  // hooks (optional)
  if (manifest.hooks !== undefined) {
    if (typeof manifest.hooks !== 'object' || manifest.hooks === null) {
      errors.push('"hooks" must be an object');
    } else {
      for (const hookName of ['post_install', 'configure', 'health_check'] as const) {
        if (manifest.hooks[hookName] !== undefined && typeof manifest.hooks[hookName] !== 'string') {
          errors.push(`"hooks.${hookName}" must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
