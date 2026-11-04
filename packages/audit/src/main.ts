import { readFileSync, statSync } from 'node:fs';
import { runCli } from './cli';

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version;
  } catch {
    // fall through to placeholder
  }
  return '0.0.0';
}

const code = runCli(
  process.argv.slice(2),
  {
    size: (path) => statSync(path).size,
    read: (path) => readFileSync(path, 'utf8'),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
  readVersion(),
);

process.exit(code);
