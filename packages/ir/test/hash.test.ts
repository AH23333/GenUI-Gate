import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/json';
import { canonicalHash, specHash } from '../src/hash';
import { sha256Hex } from '../src/sha256';
import type { IRNode, JsonValue } from '../src/types';
import { jsonArb, reverseKeys } from './helpers';

function irArbitrary(maxDepth: number): fc.Arbitrary<IRNode> {
  const propsArb = fc.dictionary(
    fc.string({ maxLength: 6 }),
    fc.oneof(
      fc.integer({ min: -1000, max: 1000 }),
      fc.string({ maxLength: 8 }),
      fc.boolean(),
      fc.constant(null),
    ),
  );
  const make = (slotsArb: fc.Arbitrary<Record<string, IRNode[]>>): fc.Arbitrary<IRNode> =>
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      type: fc.constantFrom('Text', 'Row', 'Card'),
      props: propsArb,
      slots: slotsArb,
    });
  if (maxDepth <= 0) {
    return make(fc.constant({}));
  }
  const childArb = irArbitrary(maxDepth - 1);
  return make(
    fc
      .array(childArb, { maxLength: 2 })
      .map((children): Record<string, IRNode[]> =>
        children.length === 0 ? {} : { default: children },
      ),
  );
}

/** Reverses prop AND slot key insertion order at every node (explicit stack). */
function reverseNodeKeys(root: IRNode): IRNode {
  const stack: IRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const reorderedProps: Record<string, JsonValue> = {};
    for (const key of Object.keys(node.props).reverse()) {
      reorderedProps[key] = node.props[key]!;
    }
    node.props = reorderedProps;
    const reorderedSlots: Record<string, IRNode[]> = {};
    for (const key of Object.keys(node.slots).reverse()) {
      reorderedSlots[key] = node.slots[key]!;
      for (const child of node.slots[key]!) stack.push(child);
    }
    node.slots = reorderedSlots;
  }
  return root;
}

function sampleIR(): IRNode {
  return {
    id: 'root',
    type: 'Column',
    props: { gap: 8, title: '确认对话框' },
    slots: {
      default: [
        { id: 'n1', type: 'Text', props: { content: 'hello' }, slots: {} },
        {
          id: 'n2',
          type: 'Button',
          props: { label: '确定', variant: 'primary' },
          slots: {},
        },
      ],
    },
  };
}

describe('canonicalHash', () => {
  it('is invariant to key insertion order', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('treats -0 and 0 as equal after normalization', () => {
    expect(canonicalHash(-0)).toBe(canonicalHash(0));
  });

  it('is invariant to key order for generated values', () => {
    fc.assert(
      fc.property(jsonArb(), (value: JsonValue) => {
        const copy = reverseKeys(structuredClone(value));
        expect(canonicalHash(copy)).toBe(canonicalHash(value));
      }),
      { numRuns: 200 },
    );
  });

  it('distinguishes different values', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
  });
});

describe('specHash', () => {
  it('produces a lowercase hex sha256 of the canonical form', () => {
    expect(specHash(sampleIR())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across structural copies', () => {
    expect(specHash(structuredClone(sampleIR()))).toBe(specHash(sampleIR()));
  });

  it('changes when any prop changes', () => {
    const a = sampleIR();
    const b = structuredClone(a);
    b.slots.default![1]!.props.label = '取消';
    expect(specHash(b)).not.toBe(specHash(a));
  });

  it('is invariant to slot key insertion order', () => {
    const a = sampleIR();
    const b = structuredClone(a);
    const reordered: Record<string, IRNode[]> = {};
    for (const key of Object.keys(b.slots).reverse()) {
      reordered[key] = b.slots[key]!;
    }
    b.slots = reordered;
    expect(specHash(b)).toBe(specHash(a));
  });

  it('is deterministic and insertion-order invariant on generated IRs', () => {
    fc.assert(
      fc.property(irArbitrary(3), (ir) => {
        const reordered = reverseNodeKeys(structuredClone(ir));
        expect(specHash(reordered)).toBe(specHash(ir));
        expect(specHash(structuredClone(ir))).toBe(specHash(ir));
      }),
      { numRuns: 200 },
    );
  });

  it('equals the sha256 of the canonical JSON of the IR (no extra transforms)', () => {
    fc.assert(
      fc.property(irArbitrary(3), (ir) => {
        expect(specHash(ir)).toBe(sha256Hex(canonicalize(ir as unknown as JsonValue)));
      }),
      { numRuns: 200 },
    );
  });

  it('changes when a nested prop value changes on generated IRs', () => {
    fc.assert(
      fc.property(irArbitrary(3), (ir) => {
        const mutated = structuredClone(ir);
        let target: IRNode | undefined;
        const stack: IRNode[] = [mutated];
        while (stack.length > 0 && target === undefined) {
          const node = stack.pop()!;
          if (node.props['mutation-probe-key'] === undefined) {
            target = node;
          } else {
            for (const slotName of Object.keys(node.slots)) {
              for (const child of node.slots[slotName]!) stack.push(child);
            }
          }
        }
        if (target === undefined) return false;
        target.props['mutation-probe-key'] = 1;
        expect(specHash(mutated)).not.toBe(specHash(ir));
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
