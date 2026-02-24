#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerListCommand } from './commands/list.js';
import { registerInstallCommand } from './commands/install.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerConfigureCommand } from './commands/configure.js';
import { registerStartCommand } from './commands/start.js';
import { registerStopCommand } from './commands/stop.js';
import { registerStatusCommand } from './commands/status.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { error } from './utils/logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('opendawg')
  .version(pkg.version)
  .description('Unified CLI for managing opendawg plugins');

// Register all subcommands
registerListCommand(program);
registerInstallCommand(program);
registerUninstallCommand(program);
registerConfigureCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerMigrateCommand(program);

// Handle unknown commands
program.on('command:*', (operands: string[]) => {
  error(`Unknown command: ${operands[0]}`);

  const availableCommands = program.commands.map((cmd) => cmd.name());
  const suggestion = availableCommands.find((cmd) =>
    cmd.startsWith(operands[0].slice(0, 2)),
  );

  if (suggestion) {
    console.log(`  Did you mean: opendawg ${suggestion}?`);
  }

  console.log(`  Run 'opendawg --help' to see available commands.`);
  process.exitCode = 1;
});

program.parse();
