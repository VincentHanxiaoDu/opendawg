import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { PluginInfo } from './plugin-manager.js';

const exec = promisify(execCb);

// ── Constants ────────────────────────────────────────────────────────────────

const PID_DIR = join(homedir(), '.opendawg', 'pids');
const LOG_DIR = join(homedir(), '.opendawg', 'logs');

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a native-mode plugin by running its configured start command.
 * The process runs detached. Its PID is stored in ~/.opendawg/pids/<name>.pid.
 * stdout/stderr are redirected to ~/.opendawg/logs/<name>.log.
 */
export async function startNativePlugin(plugin: PluginInfo): Promise<void> {
  const startCmd = plugin.manifest.execution?.native?.start;
  if (!startCmd) {
    throw new Error(`Plugin "${plugin.name}" has no native start command configured`);
  }

  // Don't start if already running
  if (await isPluginRunning(plugin)) {
    throw new Error(`Plugin "${plugin.name}" is already running`);
  }

  await mkdir(PID_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });

  const logFile = join(LOG_DIR, `${plugin.name}.log`);
  const pidFile = getPidFilePath(plugin.name);

  // Open log file for appending
  const { openSync, closeSync } = await import('node:fs');
  const logFd = openSync(logFile, 'a');

  try {
    // Parse the start command — it may be a shell command with pipes, etc.
    const proc = spawn('sh', ['-c', startCmd], {
      cwd: plugin.path,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      env: {
        ...process.env,
        PLUGIN_NAME: plugin.name,
        PLUGIN_DIR: plugin.path,
      },
    });

    // Unref so the parent process can exit
    proc.unref();

    if (!proc.pid) {
      throw new Error(`Failed to start plugin "${plugin.name}": no PID returned`);
    }

    // Write PID file
    await writeFile(pidFile, String(proc.pid), 'utf-8');
  } finally {
    closeSync(logFd);
  }
}

/**
 * Stop a native-mode plugin. Tries the configured stop command first,
 * then falls back to killing the PID.
 */
export async function stopNativePlugin(plugin: PluginInfo): Promise<void> {
  const pid = await readPid(plugin.name);

  // Try the configured stop command first
  const stopCmd = plugin.manifest.execution?.native?.stop;
  if (stopCmd) {
    try {
      await exec(stopCmd, {
        cwd: plugin.path,
        timeout: 15000,
        env: {
          ...process.env,
          PLUGIN_NAME: plugin.name,
          PLUGIN_DIR: plugin.path,
        },
      });
      await cleanupPidFile(plugin.name);
      return;
    } catch {
      // Stop command failed — fall through to kill by PID
    }
  }

  // Fall back to killing by PID
  if (pid !== null) {
    await killProcess(pid);
    await cleanupPidFile(plugin.name);
  }
}

/**
 * Check if a native-mode plugin is currently running.
 * Uses the health check hook if available, otherwise checks the PID.
 */
export async function isPluginRunning(plugin: PluginInfo): Promise<boolean> {
  // Prefer the health_check hook
  const healthCheckCmd = plugin.manifest.hooks?.health_check;
  if (healthCheckCmd) {
    try {
      await exec(healthCheckCmd, {
        cwd: plugin.path,
        timeout: 10000,
        env: {
          ...process.env,
          PLUGIN_NAME: plugin.name,
          PLUGIN_DIR: plugin.path,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  // Fall back to PID check
  const pid = await readPid(plugin.name);
  if (pid === null) return false;
  return isProcessAlive(pid);
}

/**
 * Get the path where a plugin's PID file would be stored.
 */
export function getPidFilePath(pluginName: string): string {
  return join(PID_DIR, `${pluginName}.pid`);
}

/**
 * Get the path where a plugin's log file would be stored.
 */
export function getLogFilePath(pluginName: string): string {
  return join(LOG_DIR, `${pluginName}.log`);
}

/**
 * List all plugins that have PID files (may or may not still be running).
 */
export async function listTrackedProcesses(): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(PID_DIR);
    return entries
      .filter((e) => e.endsWith('.pid'))
      .map((e) => e.slice(0, -4));
  } catch {
    return [];
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Read the PID from a plugin's PID file. Returns null if the file doesn't exist
 * or contains an invalid PID.
 */
async function readPid(pluginName: string): Promise<number | null> {
  const pidFile = getPidFilePath(pluginName);

  if (!existsSync(pidFile)) return null;

  try {
    const raw = await readFile(pidFile, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without actually signaling
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process, trying SIGTERM first, then SIGKILL after a timeout.
 */
async function killProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;

  // Try graceful shutdown first
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // Process already gone
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(200);
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have died between the check and the kill
  }

  // Wait briefly for SIGKILL to take effect
  await sleep(500);
}

/**
 * Remove a plugin's PID file.
 */
async function cleanupPidFile(pluginName: string): Promise<void> {
  const pidFile = getPidFilePath(pluginName);
  try {
    await unlink(pidFile);
  } catch {
    // File may not exist — that's fine
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
