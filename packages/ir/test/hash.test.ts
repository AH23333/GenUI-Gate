import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalHash, specHash } from '../src/hash';
import type { IRNode, JsonValue } from '../src/types';
import { jsonArb, reverseKeys } from './helpers';

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
});
