import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runCli, USAGE, MAX_INPUT_BYTES, type CliIo } from '../src/cli';

// Integration tests spawn node + tsx per case; under parallel worker load the
// default 5s timeout is too tight (observed flake), so raise it for this file.
vi.setConfig({ testTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const officialFixtures = join(packageRoot, '..', 'adapter-a2ui', 'test', 'fixtures', 'official');

class RecordingIo implements CliIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  sizeImpl: (path: string) => number = () => 0;
  readImpl: (path: string) => string = () => {
    throw new Error('not configured');
  };

  size(path: string): number {
    return this.sizeImpl(path);
  }

  read(path: string): string {
    return this.readImpl(path);
  }

  stdout(text: string): void {
    this.out.push(text);
  }

  stderr(text: string): void {
    this.err.push(text);
  }
}

const PASSING_FIXTURE = join(officialFixtures, 'basic-v1', '00_simple-text.json');
const BLOCKED_SPEC = JSON.stringify([
  {
    version: '1.0',
    createSurface: { surfaceId: 's', components: [{ id: 'not-root', component: 'Text' }] },
  },
]);

describe('runCli (pure core)', () => {
  it('prints usage and exits 1 when no file is given', () => {
    const io = new RecordingIo();
    expect(runCli([], io, 'v-test')).toBe(1);
    expect(io.err[0]).toBe(USAGE);
  });

  it('prints usage and exits 0 for --help', () => {
    const io = new RecordingIo();
    expect(runCli(['--help'], io, 'v-test')).toBe(0);
    expect(io.out[0]).toBe(USAGE);
  });

  it('prints the injected version for --version', () => {
    const io = new RecordingIo();
    expect(runCli(['--version'], io, '9.9.9')).toBe(0);
    expect(io.out[0]).toBe('9.9.9\n');
  });

  it('rejects unknown options with exit 1', () => {
    const io = new RecordingIo();
    expect(runCli(['--nope', 'file.json'], io, 'v-test')).toBe(1);
    expect(io.err[0]).toContain('unknown option "--nope"');
  });

  it('rejects more than one positional file', () => {
    const io = new RecordingIo();
    expect(runCli(['a.json', 'b.json'], io, 'v-test')).toBe(1);
    expect(io.err[0]).toContain('expected exactly one spec file');
  });

  it('exits 1 with a stderr message when the file cannot be read', () => {
    const io = new RecordingIo();
    io.readImpl = () => {
      throw new Error('ENOENT');
    };
    expect(runCli(['missing.json'], io, 'v-test')).toBe(1);
    expect(io.err[0]).toContain('cannot read file "missing.json"');
    expect(io.err[0]).toContain('ENOENT');
  });

  it('prints a text report and exits 0 for a passing spec', () => {
    const io = new RecordingIo();
    io.readImpl = (path) => readFileSync(path, 'utf8');
    expect(runCli([PASSING_FIXTURE], io, 'v-test')).toBe(0);
    expect(io.out[0]).toContain('GenUI Gate audit report');
    expect(io.out[0]).toContain('Overall: PASS');
  });

  it('prints a JSON report for --json', () => {
    const io = new RecordingIo();
    io.readImpl = (path) => readFileSync(path, 'utf8');
    expect(runCli(['--json', PASSING_FIXTURE], io, 'v-test')).toBe(0);
    const parsed = JSON.parse(io.out[0]!) as Record<string, unknown>;
    expect(parsed['surfaceCount']).toBe(1);
    expect(parsed['liveSurfaceCount']).toBe(1);
  });

  it('exits 2 for a blocked spec', () => {
    const io = new RecordingIo();
    io.readImpl = () => BLOCKED_SPEC;
    expect(runCli(['spec.json'], io, 'v-test')).toBe(2);
    expect(io.out[0]).toContain('Overall: BLOCK');
  });

  it('exits 2 for an empty file', () => {
    const io = new RecordingIo();
    io.readImpl = () => '';
    expect(runCli(['empty.json'], io, 'v-test')).toBe(2);
    expect(io.out[0]).toContain('parse errors present');
  });

  it('prints an identical report for a BOM-prefixed file', () => {
    const spec = readFileSync(PASSING_FIXTURE, 'utf8');
    const plain = new RecordingIo();
    const bom = new RecordingIo();
    plain.readImpl = () => spec;
    bom.readImpl = () => `\uFEFF${spec}`;
    expect(runCli(['plain.json'], plain, 'v-test')).toBe(0);
    expect(runCli(['bom.json'], bom, 'v-test')).toBe(0);
    expect(bom.out[0]).toBe(plain.out[0]);
  });

  it('exits 2 without throwing on binary garbage', () => {
    const io = new RecordingIo();
    io.readImpl = () => '\u0000\u00ff\u00fe{"broken';
    expect(runCli(['garbage.bin'], io, 'v-test')).toBe(2);
    expect(io.out.length).toBe(1);
    expect(io.out[0]).toContain('GenUI Gate audit report');
  });

  it('handles read errors that are not Error instances', () => {
    const io = new RecordingIo();
    io.readImpl = () => {
      throw 'plain string failure';
    };
    expect(runCli(['weird.json'], io, 'v-test')).toBe(1);
    expect(io.err[0]).toContain('cannot read file "weird.json"');
  });

  it('exits 1 when the input exceeds the byte limit', () => {
    const io = new RecordingIo();
    io.sizeImpl = () => MAX_INPUT_BYTES + 1;
    io.readImpl = () => {
      throw new Error('read must not be reached');
    };
    expect(runCli(['huge.json'], io, 'v-test')).toBe(1);
    expect(io.err[0]).toContain('exceeding the input limit');
    expect(io.err[0]).toContain(`is ${MAX_INPUT_BYTES + 1} bytes`);
  });

  it('accepts an input at exactly the byte limit', () => {
    const io = new RecordingIo();
    io.sizeImpl = () => MAX_INPUT_BYTES;
    io.readImpl = () => readFileSync(PASSING_FIXTURE, 'utf8');
    expect(runCli([PASSING_FIXTURE], io, 'v-test')).toBe(0);
    expect(io.out[0]).toContain('Overall: PASS');
  });
});

describe('genui-audit bin (integration)', () => {
  const tmpFiles: string[] = [];

  afterAll(() => {
    for (const file of tmpFiles) {
      try {
        rmSync(file);
      } catch {
        // best effort cleanup
      }
    }
  });

  function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'genui-audit.mjs'), ...args], {
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('runs the real CLI on a passing fixture and exits 0', () => {
    const result = runBin([PASSING_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GenUI Gate audit report');
    expect(result.stdout).toContain('Overall: PASS');
  });

  it('emits valid JSON with --json', () => {
    const result = runBin(['--json', PASSING_FIXTURE]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed['parseError']).toBe(false);
  });

  it('exits 1 for a missing file', () => {
    const result = runBin(['definitely-missing.spec.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read file');
  });

  it('exits 1 with usage when run without arguments', () => {
    const result = runBin([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: genui-audit');
  });

  it('exits 2 for a blocked spec and exits 0 for --help', () => {
    const blockedPath = join(packageRoot, 'test', 'tmp-blocked.spec.json');
    writeFileSync(blockedPath, BLOCKED_SPEC, 'utf8');
    tmpFiles.push(blockedPath);
    const blocked = runBin([blockedPath]);
    expect(blocked.status).toBe(2);
    expect(blocked.stdout).toContain('Overall: BLOCK');

    const help = runBin(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: genui-audit');
  });

  it('exits 2 on a garbage file through the real bin', () => {
    const garbagePath = join(packageRoot, 'test', 'tmp-garbage.spec.json');
    writeFileSync(garbagePath, '\u0000\u00ff\u00fe{"broken', 'utf8');
    tmpFiles.push(garbagePath);
    const result = runBin([garbagePath]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Overall: BLOCK');
  });

  it('exits 1 on an oversized input through the real bin', () => {
    const hugePath = join(packageRoot, 'test', 'tmp-huge.spec.json');
    writeFileSync(hugePath, 'x'.repeat(MAX_INPUT_BYTES + 1), 'utf8');
    tmpFiles.push(hugePath);
    const result = runBin([hugePath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeding the input limit');
  });
});
