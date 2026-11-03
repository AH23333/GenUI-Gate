import { specHash } from '@genui/ir';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adaptA2UI } from '../src/adapter';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/official', import.meta.url));

const PARSE_LEVEL_CODES = new Set([
  'parse-error',
  'unknown-message-kind',
  'duplicate-message-key',
  'invalid-message-payload',
  'unexpected-envelope-key',
]);

function listFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listFixtures(full));
    } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out.sort();
}

const fixtures = listFixtures(FIXTURE_ROOT);

describe('official A2UI golden fixtures', () => {
  it('collects the full fixture corpora', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });

  for (const file of fixtures) {
    const name = file.slice(FIXTURE_ROOT.length + 1);
    it(`translates ${name} deterministically`, () => {
      const content = readFileSync(file, 'utf8');
      const first = adaptA2UI(content);
      const second = adaptA2UI(content);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));

      const parseLevel = first.issues.filter((issue) => PARSE_LEVEL_CODES.has(issue.code));
      expect(parseLevel, `parse-level issues in ${name}`).toEqual([]);

      expect(first.surfaces.length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < first.surfaces.length; i++) {
        const surface = first.surfaces[i]!;
        const mirror = second.surfaces[i]!;
        expect(surface.ir, `surface ${surface.surfaceId} has no root in ${name}`).not.toBeNull();
        expect(specHash(surface.ir!)).toBe(specHash(mirror.ir!));
      }
    });
  }
});
