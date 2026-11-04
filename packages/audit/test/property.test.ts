import { A2UISession, parseA2UISpec } from '@genui/adapter-a2ui';
import type { IRNode } from '@genui/ir';
import { specHash } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { audit, auditExitCode } from '../src/analyze';
import { renderJson, renderText } from '../src/report';

// ---------------------------------------------------------------------------
// Deep-testing properties (开发指南 §3.1): determinism, round-trip, end-to-end
// consistency with adapter/gate/ir, and terminal-injection resistance.
// ---------------------------------------------------------------------------

const TYPES = fc.constantFrom('Text', 'Row', 'Column', 'Button', 'Card');

interface GenTree {
  type: string;
  children: GenTree[];
}

function treeArbitrary(maxDepth: number): fc.Arbitrary<GenTree> {
  if (maxDepth <= 0) {
    return fc.record({ type: TYPES, children: fc.constant([]) });
  }
  return fc.record({
    type: TYPES,
    children: fc.array(treeArbitrary(maxDepth - 1), { maxLength: 3 }),
  });
}

interface Flattened {
  spec: string;
  nodeCount: number;
}

function flatten(tree: GenTree): Flattened {
  const components: Array<Record<string, unknown>> = [];
  let counter = 0;
  const visit = (node: GenTree, id: string): void => {
    const childIds: string[] = [];
    for (let i = 0; i < node.children.length; i++) {
      counter += 1;
      childIds.push(`n${counter}`);
    }
    const entry: Record<string, unknown> = { id, component: node.type };
    if (childIds.length > 0) entry['children'] = childIds;
    components.push(entry);
    for (let i = 0; i < node.children.length; i++) {
      visit(node.children[i]!, childIds[i]!);
    }
  };
  visit(tree, 'root');
  return {
    spec: JSON.stringify({
      version: '1.0',
      createSurface: { surfaceId: 's', components },
    }),
    nodeCount: components.length,
  };
}

const validSpec = treeArbitrary(4).map(flatten);

function chainSpec(depth: number): string {
  const components: Array<Record<string, unknown>> = [];
  for (let i = 0; i < depth; i++) {
    const entry: Record<string, unknown> = { id: i === 0 ? 'root' : `n${i}`, component: 'Card' };
    if (i < depth - 1) entry['child'] = `n${i + 1}`;
    components.push(entry);
  }
  return JSON.stringify({ version: '1.0', createSurface: { surfaceId: 's', components } });
}

function countNodes(root: IRNode): number {
  let count = 0;
  const stack: IRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    for (const slotName of Object.keys(node.slots)) {
      for (const child of node.slots[slotName]!) stack.push(child);
    }
  }
  return count;
}

/** Every C0/C1 control character (plus DEL) an attacker could smuggle in an id. */
const EVIL = fc.constantFrom('\x1b', '\x1b[2J', '\x1b]0;pwned\x07', '\r', '\n', '\r\n', '\x00', '\x07', '\x7f');

const hostileArbitrary = fc.record({
  prefix: fc.string({ maxLength: 8 }),
  evil: EVIL,
  suffix: fc.string({ maxLength: 8 }),
});

function hasNoControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 10 && (code < 32 || code === 127)) return false;
  }
  return true;
}

describe('audit property tests', () => {
  it('is deterministic: identical input, byte-identical report (incl. irHash)', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        expect(JSON.stringify(audit(gen.spec))).toBe(JSON.stringify(audit(gen.spec)));
      }),
      { numRuns: 100 },
    );
  });

  it('renderJson round-trips through JSON.parse', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        const report = audit(gen.spec);
        expect(JSON.parse(renderJson(report))).toEqual(report);
      }),
      { numRuns: 100 },
    );
  });

  it('agrees with an independent adapter + ir recomputation (end-to-end consistency)', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        const report = audit(gen.spec);
        const session = new A2UISession();
        session.applyAll(parseA2UISpec(gen.spec).messages);
        const surface = session.snapshot().surfaces[0]!;
        const ir = surface.ir!;
        const surfaceReport = report.surfaces[0]!;
        expect(report.adapterIssueCount).toBe(0);
        expect(report.parseError).toBe(false);
        expect(report.surfaceCount).toBe(1);
        expect(report.totalNodes).toBe(gen.nodeCount);
        expect(surfaceReport.nodeCount).toBe(countNodes(ir));
        expect(surfaceReport.componentCount).toBe(gen.nodeCount);
        expect(surfaceReport.irHash).toBe(specHash(ir));
        expect(surfaceReport.verdict).toBe('pass');
        expect(surfaceReport.blocked).toBe(false);
        expect(auditExitCode(report)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('blocks and exits 2 for every over-depth chain', () => {
    fc.assert(
      fc.property(fc.integer({ min: 33, max: 60 }), (depth) => {
        const report = audit(chainSpec(depth));
        expect(report.surfaces[0]!.verdict).toBe('block');
        expect(report.surfaces[0]!.ruleHits.map((h) => h.ruleId)).toContain('limits.tree-depth');
        expect(report.blockedSurfaceCount).toBe(1);
        expect(auditExitCode(report)).toBe(2);
      }),
      { numRuns: 100 },
    );
  });

  it('is invariant to a UTF-8 BOM prefix', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        expect(audit(`\uFEFF${gen.spec}`)).toEqual(audit(gen.spec));
      }),
      { numRuns: 100 },
    );
  });

  it('renders hostile ids without leaking any control character (terminal injection lock)', () => {
    fc.assert(
      fc.property(hostileArbitrary, hostileArbitrary, (surfaceGen, componentGen) => {
        const surfaceId = `${surfaceGen.prefix}${surfaceGen.evil}${surfaceGen.suffix}`;
        const componentId = `${componentGen.prefix}${componentGen.evil}${componentGen.suffix}`;
        const spec = JSON.stringify({
          version: '1.0',
          createSurface: {
            surfaceId,
            components: [
              { id: 'root', component: 'Column', children: [componentId] },
              { id: componentId, component: 'Text', text: 'hi' },
            ],
          },
        });
        const report = audit(spec);
        expect(report.surfaceCount).toBe(1);
        const text = renderText(report);
        expect(hasNoControlChars(text)).toBe(true);
        expect(() => JSON.parse(renderJson(report))).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('never throws on arbitrary text input and always renders safely (fuzz)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.json(),
          fc.string({ minLength: 0, maxLength: 5 }).map((s) => `[${s}`),
        ),
        (text) => {
          const report = audit(text);
          const json = renderJson(report);
          expect(() => JSON.parse(json)).not.toThrow();
          const rendered = renderText(report);
          expect(rendered.length).toBeGreaterThan(0);
          expect([0, 2]).toContain(auditExitCode(report));
        },
      ),
      { numRuns: 100 },
    );
  });
});
