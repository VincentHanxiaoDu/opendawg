import chalk from 'chalk';
import Table from 'cli-table3';

export function info(msg: string): void {
  console.log(chalk.blue('ℹ'), msg);
}

export function success(msg: string): void {
  console.log(chalk.green('✔'), msg);
}

export function warn(msg: string): void {
  console.warn(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✖'), msg);
}

export function debug(msg: string): void {
  if (process.env.OPENDAWG_DEBUG === '1' || process.env.OPENDAWG_DEBUG === 'true') {
    console.log(chalk.gray('[debug]'), msg);
  }
}

export function table(headers: string[], rows: string[][]): void {
  const t = new Table({
    head: headers.map((h) => chalk.cyan(h)),
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    t.push(row);
  }

  console.log(t.toString());
}

export function spinner(msg: string): { stop: (finalMsg?: string) => void } {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i % frames.length])} ${msg}`);
    i++;
  }, 80);

  return {
    stop(finalMsg?: string) {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(msg.length + 4) + '\r');
      if (finalMsg) {
        success(finalMsg);
      }
    },
  };
}
