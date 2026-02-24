import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { PluginInfo } from './plugin-manager.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComposeOptions {
  /** Docker Compose project name (--project-name) */
  projectName?: string;
  /** Profiles to activate (--profile) */
  profiles?: string[];
  /** Detach for `up` (default true) */
  detach?: boolean;
  /** Remove orphans on `down` */
  removeOrphans?: boolean;
  /** Additional raw args to pass after the action */
  extraArgs?: string[];
  /** Environment variables to pass to docker compose */
  env?: Record<string, string>;
}

export interface ComposeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Collect Docker Compose file paths from all enabled, docker-mode plugins.
 * Only returns paths that actually exist on disk.
 */
export function collectComposeFiles(plugins: PluginInfo[], pluginsDir: string): string[] {
  const files: string[] = [];

  for (const plugin of plugins) {
    // Only include plugins that run in docker mode
    if (plugin.state.executionMode !== 'docker') continue;
    if (!plugin.state.enabled) continue;

    const composePath = plugin.manifest.execution?.docker?.compose;
    if (!composePath) continue;

    // Resolve relative to the plugin directory
    const fullPath = resolve(plugin.path, composePath);

    if (existsSync(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Build a `docker compose` command array from compose files, an action, and options.
 *
 * Example output:
 *   ["docker", "compose", "-f", "/path/a.yaml", "-f", "/path/b.yaml", "--project-name", "opendawg", "up", "-d"]
 */
export function buildComposeCommand(
  composeFiles: string[],
  action: 'up' | 'down' | 'ps' | 'logs' | 'restart' | 'pull',
  options?: ComposeOptions,
): string[] {
  const args: string[] = ['docker', 'compose'];

  // File flags
  for (const file of composeFiles) {
    args.push('-f', file);
  }

  // Project name
  if (options?.projectName) {
    args.push('--project-name', options.projectName);
  }

  // Profiles
  if (options?.profiles) {
    for (const profile of options.profiles) {
      args.push('--profile', profile);
    }
  }

  // Action
  args.push(action);

  // Action-specific flags
  if (action === 'up') {
    if (options?.detach !== false) {
      args.push('-d');
    }
  }

  if (action === 'down') {
    if (options?.removeOrphans) {
      args.push('--remove-orphans');
    }
  }

  // Extra raw args
  if (options?.extraArgs) {
    args.push(...options.extraArgs);
  }

  return args;
}

/**
 * Execute a docker compose command and capture its output.
 * The first element of `args` should be `"docker"` (as returned by `buildComposeCommand`).
 */
export async function runCompose(
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string },
): Promise<ComposeResult> {
  const [command, ...commandArgs] = args;

  return new Promise((resolve) => {
    const proc = spawn(command, commandArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options?.env },
      cwd: options?.cwd,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });

    proc.on('error', (err) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

/**
 * Convenience: build and run a compose command in one step.
 */
export async function execCompose(
  composeFiles: string[],
  action: 'up' | 'down' | 'ps' | 'logs' | 'restart' | 'pull',
  options?: ComposeOptions,
): Promise<ComposeResult> {
  const args = buildComposeCommand(composeFiles, action, options);
  return runCompose(args, { env: options?.env });
}
