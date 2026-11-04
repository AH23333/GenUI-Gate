#!/usr/bin/env node
// M0 launcher: runs the TypeScript CLI via `node --import tsx` (tsx's
// documented usage) so no build step is needed. Build/publish strategy lands
// at release time (KAN-002).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

let tsxEntry;
try {
  tsxEntry = require.resolve('tsx');
} catch {
  console.error('genui-audit: "tsx" is not installed. Run `pnpm install` first.');
  process.exit(1);
}

const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const child = spawnSync(
  process.execPath,
  ['--import', pathToFileURL(tsxEntry).href, entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(child.status ?? 1);
