import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, auditExitCode } from '../src/analyze';
import type { AuditReport } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const officialFixtures = join(here, '..', '..', 'adapter-a2ui', 'test', 'fixtures', 'official');

function readOfficial(...segments: string[]): string {
  return readFileSync(join(officialFixtures, ...segments), 'utf8');
}

type Component = { id: string; component: string } & Record<string, unknown>;

function createSurface(
  surfaceId: string,
  components: Component[],
): string {
  return JSON.stringify([
    {
      version: '1.0',
      createSurface: { surfaceId, components },
    },
  ]);
}

function auditSpec(spec: string): AuditReport {
  return audit(spec);
}

describe('audit: official fixtures', () => {
  it('reports a passing basic-v1 example', () => {
    const report = audit(readOfficial('basic-v1', '00_simple-text.json'));
    expect(report.surfaceCount).toBe(1);
    expect(report.liveSurfaceCount).toBe(1);
    expect(report.blockedSurfaceCount).toBe(0);
    expect(report.parseError).toBe(false);
    expect(report.adapterIssueCount).toBe(0);
    expect(report.surfaces[0]?.nodeCount).toBeGreaterThan(0);
    expect(report.surfaces[0]?.irHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.surfaces[0]?.verdict).toBe('pass');
    expect(report.totalComponents).toBe(report.surfaces[0]?.componentCount);
    expect(auditExitCode(report)).toBe(0);
  });

  it('reports the v1.0 contact_form JSONL lifecycle (ends deleted) as passing', () => {
    const report = audit(readOfficial('spec-cases', 'contact_form_v1_0.jsonl'));
    expect(report.parseError).toBe(false);
    expect(report.surfaceCount).toBe(1);
    expect(report.liveSurfaceCount).toBe(0);
    expect(report.surfaces[0]?.deleted).toBe(true);
    expect(report.surfaces[0]?.blocked).toBe(false);
    expect(auditExitCode(report)).toBe(0);
  });

  it('is deterministic (same input, identical report)', () => {
    const raw = readOfficial('basic-v1', '06_music-player.json');
    expect(audit(raw)).toEqual(audit(raw));
  });

  it('strips a leading BOM before hashing and parsing', () => {
    const raw = readOfficial('basic-v1', '00_simple-text.json');
    expect(audit(`\uFEFF${raw}`)).toEqual(audit(raw));
  });
});

describe('audit: exit code semantics (fail-closed)', () => {
  it('blocks on parse errors', () => {
    const report = audit('this is not json');
    expect(report.parseError).toBe(true);
    expect(report.surfaceCount).toBe(0);
    expect(auditExitCode(report)).toBe(2);
  });

  it('blocks on empty input', () => {
    const report = audit('   ');
    expect(report.parseError).toBe(true);
    expect(auditExitCode(report)).toBe(2);
  });

  it('blocks when no live surface exists (valid JSON, zero surfaces)', () => {
    const report = audit('{}');
    expect(report.parseError).toBe(false);
    expect(report.surfaceCount).toBe(0);
    expect(auditExitCode(report)).toBe(2);
  });

  it('treats a completed (deleted) surface lifecycle as passing, but blocks zero-surface input', () => {
    const spec = JSON.stringify([
      { version: '1.0', createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Card' }] } },
      { version: '1.0', deleteSurface: { surfaceId: 's' } },
    ]);
    const report = auditSpec(spec);
    expect(report.liveSurfaceCount).toBe(0);
    expect(report.surfaceCount).toBe(1);
    const surface = report.surfaces[0]!;
    expect(surface.deleted).toBe(true);
    expect(surface.blocked).toBe(false);
    expect(surface.irHash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditExitCode(report)).toBe(0);

    const empty = audit('[]');
    expect(empty.surfaceCount).toBe(0);
    expect(auditExitCode(empty)).toBe(2);
  });

  it('blocks a live surface without a renderable tree (missing root)', () => {
    const report = auditSpec(createSurface('s', [{ id: 'lonely', component: 'Text' }]));
    const surface = report.surfaces[0]!;
    expect(surface.blocked).toBe(true);
    expect(surface.irHash).toBeUndefined();
    expect(surface.nodeCount).toBe(0);
    expect(surface.verdict).toBe('pass');
    expect(report.adapterIssues.some((g) => g.code === 'missing-root')).toBe(true);
    expect(report.blockedSurfaceCount).toBe(1);
    expect(auditExitCode(report)).toBe(2);
  });

  it('groups parse errors across JSONL lines with capped samples', () => {
    const lines = ['garbage one', 'garbage two', 'garbage three', 'garbage four'].join('\n');
    const report = audit(lines);
    const group = report.adapterIssues.find((g) => g.code === 'parse-error');
    expect(group?.count).toBe(4);
    expect(group?.samples).toHaveLength(3);
    expect(report.parseError).toBe(true);
  });
});

describe('audit: gate wiring', () => {
  it('reports limits.tree-depth for an over-deep chain', () => {
    const depth = 40;
    const components: Component[] = [];
    for (let i = 0; i < depth; i++) {
      const c: Component = { id: i === 0 ? 'root' : `n${i}`, component: 'Card' };
      if (i + 1 < depth) c.child = `n${i + 1}`;
      components.push(c);
    }
    const report = auditSpec(createSurface('s', components));
    const surface = report.surfaces[0]!;
    expect(surface.verdict).toBe('block');
    expect(surface.blocked).toBe(true);
    const hit = surface.ruleHits.find((h) => h.ruleId === 'limits.tree-depth');
    expect(hit?.count).toBeGreaterThan(0);
    expect(hit?.severity).toBe('critical');
    expect(hit?.action).toBe('block');
    expect(hit?.samples[0]?.message).toContain('exceeds limit');
    expect(auditExitCode(report)).toBe(2);
  });

  it('reports limits.prop-size for oversized props', () => {
    const big = 'x'.repeat(20000);
    const report = auditSpec(
      createSurface('s', [
        { id: 'root', component: 'Text', a: big, b: big, c: big, d: big, e: big },
      ]),
    );
    const surface = report.surfaces[0]!;
    expect(surface.verdict).toBe('block');
    const hit = surface.ruleHits.find((h) => h.ruleId === 'limits.prop-size');
    expect(hit?.count).toBe(5);
    expect(hit?.samples).toHaveLength(3);
    expect(auditExitCode(report)).toBe(2);
  });

  it('counts nodes and depth of a known tree', () => {
    const report = auditSpec(
      createSurface('s', [
        { id: 'root', component: 'Row', children: ['a', 'b'] },
        { id: 'a', component: 'Card', child: 'a1' },
        { id: 'a1', component: 'Text' },
        { id: 'b', component: 'Text' },
      ]),
    );
    const surface = report.surfaces[0]!;
    expect(surface.nodeCount).toBe(4);
    expect(surface.maxDepth).toBe(3);
    expect(report.totalNodes).toBe(4);
    expect(surface.verdict).toBe('pass');
    expect(auditExitCode(report)).toBe(0);
  });
});

describe('audit: a11y baseline', () => {
  it('counts accessibility metadata coverage over the rendered tree', () => {
    const report = auditSpec(
      createSurface('s', [
        { id: 'root', component: 'Column', children: ['a', 'b', 'c'], accessibility: { label: 'root label' } },
        { id: 'a', component: 'Text', accessibility: { description: 'd', live: 'polite', hidden: true } },
        { id: 'b', component: 'Text', accessibility: { label: '' } },
        { id: 'c', component: 'Text' },
      ]),
    );
    const a11y = report.surfaces[0]!.a11y;
    expect(a11y.nodes).toBe(4);
    expect(a11y.withAccessibility).toBe(3);
    expect(a11y.withLabel).toBe(1);
    expect(a11y.withDescription).toBe(1);
    expect(a11y.withLive).toBe(1);
    expect(a11y.withHidden).toBe(1);
  });

  it('ignores non-object accessibility props', () => {
    const report = auditSpec(
      createSurface('s', [{ id: 'root', component: 'Text', accessibility: 'nope' }]),
    );
    const a11y = report.surfaces[0]!.a11y;
    expect(a11y.nodes).toBe(1);
    expect(a11y.withAccessibility).toBe(0);
  });
});

describe('audit: report totals', () => {
  it('aggregates across multiple surfaces', () => {
    const report = audit(
      JSON.stringify([
        {
          version: '1.0',
          createSurface: { surfaceId: 'a', catalogId: 'basic-v1', components: [{ id: 'root', component: 'Text' }] },
        },
        {
          version: '1.0',
          createSurface: { surfaceId: 'b', components: [{ id: 'root', component: 'Row', children: ['x'] }, { id: 'x', component: 'Text' }] },
        },
      ]),
    );
    expect(report.surfaceCount).toBe(2);
    expect(report.liveSurfaceCount).toBe(2);
    expect(report.surfaces[0]?.catalogId).toBe('basic-v1');
    expect(report.surfaces[1]?.catalogId).toBeUndefined();
    expect(report.totalComponents).toBe(3);
    expect(report.totalNodes).toBe(3);
    expect(report.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(auditExitCode(report)).toBe(0);
  });

  it('records input size in UTF-8 bytes', () => {
    const report = audit('{"a": 1}');
    expect(report.inputBytes).toBe(8);
  });
});
