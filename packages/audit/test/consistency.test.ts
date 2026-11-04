import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, auditExitCode } from '../src/analyze';

/**
 * A8 cross-platform determinism device (v2 assumption A8):
 * full pipeline digests (parse + adapt + canonical hash + gate) over the whole
 * official corpus, asserted against goldens committed from one platform and
 * re-verified by the CI matrix (ubuntu/windows x node 22).
 *
 * Regenerate with: UPDATE_GOLDENS=1 pnpm vitest run packages/audit/test/consistency.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, '..', '..', 'adapter-a2ui', 'test', 'fixtures', 'official');
const goldenPath = join(here, 'goldens', 'pipeline.json');

interface GoldenSurface {
  surfaceId: string;
  componentCount: number;
  nodeCount: number;
  verdict: string;
  irHash: string | null;
}

interface GoldenEntry {
  file: string;
  inputBytes: number;
  inputSha256: string;
  surfaceCount: number;
  totalNodes: number;
  adapterIssueCount: number;
  exitCode: 0 | 2;
  surfaces: GoldenSurface[];
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function corpusFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
        files.push(toPosix(full.slice(corpusRoot.length + 1)));
      }
    }
  };
  walk(corpusRoot);
  files.sort();
  return files;
}

function buildGoldens(): GoldenEntry[] {
  return corpusFiles().map((file) => {
    const raw = readFileSync(join(corpusRoot, file), 'utf8');
    const report = audit(raw);
    return {
      file,
      inputBytes: report.inputBytes,
      inputSha256: report.inputSha256,
      surfaceCount: report.surfaceCount,
      totalNodes: report.totalNodes,
      adapterIssueCount: report.adapterIssueCount,
      exitCode: auditExitCode(report),
      surfaces: report.surfaces.map((surface) => ({
        surfaceId: surface.surfaceId,
        componentCount: surface.componentCount,
        nodeCount: surface.nodeCount,
        verdict: surface.verdict,
        irHash: surface.irHash ?? null,
      })),
    };
  });
}

describe('cross-platform pipeline goldens (A8)', () => {
  it('matches committed full-pipeline digests for the whole official corpus', () => {
    const actual = buildGoldens();
    if (process.env['UPDATE_GOLDENS'] === '1') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      console.log(`goldens written: ${goldenPath} (${actual.length} entries)`);
      return;
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenEntry[];
    expect(golden.length).toBe(actual.length);
    expect(actual).toEqual(golden);
  });

  it('covers the complete official corpus (all fixtures present in goldens)', () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenEntry[];
    expect(golden.map((g) => g.file)).toEqual(corpusFiles());
  });
});
