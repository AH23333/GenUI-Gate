import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit } from '../src/analyze';
import { renderJson, renderText } from '../src/report';
import type { AuditReport } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));

function official(...segments: string[]): string {
  return readFileSync(
    join(here, '..', '..', 'adapter-a2ui', 'test', 'fixtures', 'official', ...segments),
    'utf8',
  );
}

function passingReport(): AuditReport {
  return audit(official('basic-v1', '06_music-player.json'));
}

function blockedReport(): AuditReport {
  return audit(JSON.stringify([
    {
      version: '1.0',
      createSurface: { surfaceId: 'broken', components: [{ id: 'not-root', component: 'Text' }] },
    },
  ]));
}

function parseErrorReport(): AuditReport {
  return audit('garbage');
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

describe('renderText', () => {
  it('renders a passing report with the surface, verdict, and overall PASS', () => {
    const text = renderText(passingReport());
    expect(text).toContain('GenUI Gate audit report');
    expect(text).toContain('Verdict: pass');
    expect(text).toContain('Overall: PASS');
    expect(text).toContain('Rule violations: none');
    expect(text).toContain('IR hash: ');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders a blocked report with block reasons and the overall BLOCK', () => {
    const text = renderText(blockedReport());
    expect(text).toContain('[blocked]');
    expect(text).toContain('Overall: BLOCK (1 surface(s) blocked)');
    expect(text).toContain('missing-root');
  });

  it('renders parse errors and issue groups with samples', () => {
    const text = renderText(parseErrorReport());
    expect(text).toContain('Adapter issues:');
    expect(text).toContain('parse-error x1');
    expect(text).toContain('Overall: BLOCK');
    expect(text).toContain('parse errors present');
  });

  it('marks deleted surfaces without counting them as blocked', () => {
    const report = audit(JSON.stringify([
      {
        version: '1.0',
        createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Text' }] },
      },
      { version: '1.0', deleteSurface: { surfaceId: 's' } },
    ]));
    const text = renderText(report);
    expect(text).toContain('[deleted]');
    expect(text).toContain('Overall: PASS');
    expect(text).not.toContain('[blocked]');
    expect(text).not.toContain('Overall: BLOCK');
  });

  it('renders each rule hit with severity, action, count, and samples', () => {
    const depth = 40;
    const components: Array<Record<string, unknown>> = [];
    for (let i = 0; i < depth; i++) {
      components.push({
        id: i === 0 ? 'root' : `n${i}`,
        component: 'Card',
        ...(i + 1 < depth ? { child: `n${i + 1}` } : {}),
      });
    }
    const deep = audit(
      JSON.stringify([
        { version: '1.0', createSurface: { surfaceId: 's', components } },
      ]),
    );
    expect(deep.surfaces[0]?.ruleHits.length).toBeGreaterThan(0);
    const text = renderText(deep);
    expect(text).toContain('Rule: limits.tree-depth (critical/block) x');
    expect(text).toContain('exceeds limit');
  });

  it('stays ASCII-only across pass, block, and parse-error reports', () => {
    for (const report of [passingReport(), blockedReport(), parseErrorReport()]) {
      expect(isAscii(renderText(report))).toBe(true);
    }
  });
});

describe('renderJson', () => {
  it('round-trips a passing report losslessly', () => {
    const report = passingReport();
    const parsed = JSON.parse(renderJson(report)) as AuditReport;
    expect(parsed).toEqual(report);
  });

  it('round-trips a blocked report losslessly', () => {
    const report = blockedReport();
    const parsed = JSON.parse(renderJson(report)) as AuditReport;
    expect(parsed).toEqual(report);
  });

  it('ends with a newline', () => {
    expect(renderJson(passingReport()).endsWith('\n')).toBe(true);
  });
});
