import type { IRNode } from '@genui/ir';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, checkLimits } from '../src/limits';

function leaf(id: string): IRNode {
  return { id, type: 'Text', props: {}, slots: {} };
}

function chain(depth: number): IRNode {
  const root = leaf('n0');
  let current = root;
  for (let i = 1; i < depth; i++) {
    const child = leaf(`n${i}`);
    current.slots = { default: [child] };
    current = child;
  }
  return root;
}

function wide(count: number): IRNode {
  const children = Array.from({ length: count }, (_, i) => leaf(`c${i}`));
  return { id: 'root', type: 'Row', props: {}, slots: { default: children } };
}

describe('checkLimits', () => {
  it('passes a small tree with no violations', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Column',
      props: { gap: 8 },
      slots: {
        default: [
          { id: 'n1', type: 'Text', props: { content: 'hello' }, slots: {} },
          { id: 'n2', type: 'Button', props: { label: '确定' }, slots: {} },
        ],
      },
    };
    expect(checkLimits(ir, DEFAULT_LIMITS)).toEqual([]);
  });

  it('flags depth beyond the limit at the offending path', () => {
    const violations = checkLimits(chain(33), DEFAULT_LIMITS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: 'limits.tree-depth',
      action: 'block',
      severity: 'critical',
    });
    expect(violations[0]!.nodePath).toContain('slots.default[0]');
  });

  it('does not flag depth exactly at the limit', () => {
    expect(checkLimits(chain(32), DEFAULT_LIMITS)).toEqual([]);
  });

  it('flags node count beyond the limit and stops scanning', () => {
    const violations = checkLimits(chain(2500), DEFAULT_LIMITS);
    expect(violations[0]!.ruleId).toBe('limits.tree-depth');
    expect(violations.at(-1)!.ruleId).toBe('limits.node-count');
    expect(violations.length).toBeLessThan(2 * DEFAULT_LIMITS.maxNodes);
  });

  it('flags children count beyond the limit', () => {
    const violations = checkLimits(wide(65), DEFAULT_LIMITS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: 'limits.children-count',
      action: 'block',
    });
  });

  it('does not flag children count exactly at the limit', () => {
    expect(checkLimits(wide(64), DEFAULT_LIMITS)).toEqual([]);
  });

  it('flags oversized string props by UTF-8 byte length', () => {
    const ascii = 'x'.repeat(20000);
    const cjk = '好'.repeat(6000);
    for (const content of [ascii, cjk]) {
      const node: IRNode = { id: 'a', type: 'Text', props: { content }, slots: {} };
      const violations = checkLimits(node, DEFAULT_LIMITS);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        ruleId: 'limits.prop-size',
        action: 'block',
        nodePath: '<root>.props.content',
      });
    }
  });

  it('does not flag props at exactly the byte limit', () => {
    const node: IRNode = {
      id: 'a',
      type: 'Text',
      props: { content: 'x'.repeat(DEFAULT_LIMITS.maxPropBytes) },
      slots: {},
    };
    expect(checkLimits(node, DEFAULT_LIMITS)).toEqual([]);
  });

  it('measures nested array/object props by total string bytes', () => {
    const within: IRNode = {
      id: 'a',
      type: 'Text',
      props: { config: { items: ['x'.repeat(100), { nested: 'y'.repeat(100) }] } },
      slots: {},
    };
    expect(checkLimits(within, DEFAULT_LIMITS)).toEqual([]);

    const over: IRNode = {
      id: 'a',
      type: 'Text',
      props: { config: { items: ['x'.repeat(8200), 'y'.repeat(8200)] } },
      slots: {},
    };
    const violations = checkLimits(over, DEFAULT_LIMITS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ruleId: 'limits.prop-size', action: 'block' });
  });

  it('fails closed when a prop scan exceeds the budget (cyclic prop)', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const node = {
      id: 'a',
      type: 'Text',
      props: { bad: cyclic },
      slots: {},
    } as unknown as IRNode;
    const violations = checkLimits(node, DEFAULT_LIMITS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ruleId: 'limits.prop-size', action: 'block' });
    expect(violations[0]!.message).toContain('scan budget');
  });

  it('never hangs on cyclic trees (fail-closed via node count)', () => {
    const a = leaf('a');
    const b = leaf('b');
    a.slots = { default: [b] };
    b.slots = { default: [a] };
    const violations = checkLimits(a, { ...DEFAULT_LIMITS, maxNodes: 10 });
    expect(violations.some((v) => v.ruleId === 'limits.node-count')).toBe(true);
  });

  it('walks a 10k-deep tree without stack overflow', () => {
    const violations = checkLimits(chain(10_000), DEFAULT_LIMITS);
    const byRule = new Set(violations.map((v) => v.ruleId));
    expect(byRule.has('limits.tree-depth')).toBe(true);
    expect(byRule.has('limits.node-count')).toBe(true);
  });

  it('walks in document order for deterministic violation paths', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Column',
      props: {},
      slots: {
        header: [leaf('h1')],
        default: [leaf('d1'), leaf('d2')],
      },
    };
    const deepHeader = chain(40);
    const irWithDeep: IRNode = {
      id: 'root',
      type: 'Column',
      props: {},
      slots: {
        header: [deepHeader],
        default: [leaf('d1')],
      },
    };
    expect(checkLimits(ir, DEFAULT_LIMITS)).toEqual([]);
    const violations = checkLimits(irWithDeep, DEFAULT_LIMITS);
    expect(violations[0]!.nodePath.startsWith('<root>/slots.header[0]')).toBe(true);
  });
});
