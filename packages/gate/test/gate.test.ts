import type { IRNode, JsonValue } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aggregate, gate } from '../src/gate';
import type { TraceEntry } from '../src/types';

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

function treeArbitrary(maxDepth: number): fc.Arbitrary<IRNode> {
  const makeNode = (slotsArb: fc.Arbitrary<Record<string, IRNode[]>>): fc.Arbitrary<IRNode> =>
    fc.record({
      id: fc.nat({ max: 999999 }).map((n) => `n${n}`),
      type: fc.constantFrom('Text', 'Row', 'Button'),
      props: fc.constant({}),
      slots: slotsArb,
    });
  if (maxDepth <= 0) {
    return makeNode(fc.constant({}));
  }
  const childArb = treeArbitrary(maxDepth - 1);
  return makeNode(
    fc
      .array(childArb, { maxLength: 2 })
      .map((children): Record<string, IRNode[]> =>
        children.length === 0 ? {} : { default: children },
      ),
  );
}

function sampleTree(): IRNode {
  return {
    id: 'root',
    type: 'Column',
    props: { gap: 8 },
    slots: {
      default: [
        { id: 'n1', type: 'Text', props: { content: 'hello' }, slots: {} },
        {
          id: 'n2',
          type: 'Button',
          props: { label: '确定' },
          slots: { default: [leaf('n3')] },
        },
      ],
    },
  };
}

describe('gate', () => {
  it('passes a valid tree untouched', () => {
    const ir = sampleTree();
    const result = gate(ir);
    expect(result.verdict).toBe('pass');
    expect(result.trace).toEqual([]);
    expect(result.ir).toBe(ir);
  });

  it('blocks on limit violations', () => {
    const result = gate(chain(40));
    expect(result.verdict).toBe('block');
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.trace.every((entry) => entry.action === 'block')).toBe(true);
  });

  it('respects custom limits', () => {
    expect(gate(chain(5), { limits: { maxDepth: 3 } }).verdict).toBe('block');
    expect(gate(chain(5), { limits: { maxDepth: 8 } }).verdict).toBe('pass');
  });

  it('is deterministic for identical input', () => {
    const ir = sampleTree();
    const first = gate(ir);
    const second = gate(ir);
    expect(first.verdict).toBe(second.verdict);
    expect(first.trace).toEqual(second.trace);
  });
});

describe('aggregate', () => {
  it('returns pass for an empty trace', () => {
    expect(aggregate([])).toBe('pass');
  });

  it('keeps the strictest action', () => {
    const entries: TraceEntry[] = [
      { ruleId: 'a', severity: 'info', action: 'transform', nodePath: '', message: '' },
      { ruleId: 'b', severity: 'error', action: 'block', nodePath: '', message: '' },
      { ruleId: 'c', severity: 'info', action: 'pass', nodePath: '', message: '' },
    ];
    expect(aggregate(entries)).toBe('block');
    expect(aggregate([entries[0]!, entries[2]!])).toBe('transform');
    expect(aggregate([entries[2]!])).toBe('pass');
  });
});

describe('gate property tests', () => {
  it('passes every generated tree within limits', () => {
    fc.assert(
      fc.property(treeArbitrary(3), (ir) => {
        const result = gate(ir);
        expect(result.verdict).toBe('pass');
        expect(result.trace).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('never throws and stays deterministic for any generated tree', () => {
    fc.assert(
      fc.property(treeArbitrary(3), (ir) => {
        const first = gate(ir);
        const second = gate(ir);
        expect(first.verdict).toBe(second.verdict);
        expect(JSON.stringify(first.trace)).toBe(JSON.stringify(second.trace));
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('treats JsonValue props consistently', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 6 }), fc.integer({ min: -1000, max: 1000 })),
        (props) => {
          const ir: IRNode = {
            id: 'root',
            type: 'Text',
            props: props as Record<string, JsonValue>,
            slots: {},
          };
          const result = gate(ir);
          expect(result.verdict).toBe('pass');
        },
      ),
      { numRuns: 100 },
    );
  });
});
