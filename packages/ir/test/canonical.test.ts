import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CanonicalizationError,
  canonicalize,
  isJsonValue,
  MAX_JSON_DEPTH,
} from '../src/json';
import type { JsonValue } from '../src/types';
import { jsonArb, reverseKeys, wrapArrays } from './helpers';

const GOLDEN: ReadonlyArray<{ value: JsonValue; expected: string }> = [
  { value: null, expected: 'null' },
  { value: true, expected: 'true' },
  { value: false, expected: 'false' },
  { value: 42, expected: '42' },
  { value: -42, expected: '-42' },
  { value: 1.5, expected: '1.5' },
  { value: -0, expected: '0' },
  { value: 1e21, expected: '1e+21' },
  { value: 0.000001, expected: '0.000001' },
  { value: '', expected: '""' },
  { value: 'hi', expected: '"hi"' },
  { value: 'a"b\\c\n', expected: '"a\\"b\\\\c\\n"' },
  { value: String.fromCharCode(1), expected: '"\\u0001"' },
  { value: [], expected: '[]' },
  { value: {}, expected: '{}' },
  { value: [3, 1, 2], expected: '[3,1,2]' },
  { value: [1, [2, [3]]], expected: '[1,[2,[3]]]' },
  { value: { b: 1, a: 2 }, expected: '{"a":2,"b":1}' },
  { value: { B: 1, a: 2, '2': 3 }, expected: '{"2":3,"B":1,"a":2}' },
  { value: { z: { y: [true, null], x: 's' } }, expected: '{"z":{"x":"s","y":[true,null]}}' },
  { value: { '\n': 1 }, expected: '{"\\n":1}' },
  { value: { '😀': 1, ÿ: 2, A: 3 }, expected: '{"A":3,"ÿ":2,"😀":1}' },
];

describe('canonicalize', () => {
  it('produces golden canonical forms', () => {
    for (const { value, expected } of GOLDEN) {
      expect(canonicalize(value)).toBe(expected);
    }
  });

  it('round-trips through JSON.parse', () => {
    fc.assert(
      fc.property(jsonArb(), (value) => {
        expect(JSON.parse(canonicalize(value))).toStrictEqual(value);
      }),
      { numRuns: 300 },
    );
  });

  it('is invariant to key insertion order', () => {
    fc.assert(
      fc.property(jsonArb(), (value) => {
        expect(canonicalize(reverseKeys(value))).toBe(canonicalize(value));
      }),
      { numRuns: 300 },
    );
  });

  it('accepts nesting up to MAX_JSON_DEPTH and rejects beyond', () => {
    expect(() => canonicalize(wrapArrays(1, MAX_JSON_DEPTH))).not.toThrow();
    expect(() => canonicalize(wrapArrays(1, MAX_JSON_DEPTH + 1))).toThrow(CanonicalizationError);
  });

  it('rejects values that are not JSON', () => {
    const bad: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      () => {},
      Symbol('x'),
      BigInt(1),
      new Date(),
      new Map(),
      { a: undefined },
      [1, undefined],
    ];
    for (const value of bad) {
      expect(() => canonicalize(value as JsonValue)).toThrow(CanonicalizationError);
    }
  });

  it('rejects cyclic references', () => {
    const cyclicArray: JsonValue[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalize(cyclicArray as unknown as JsonValue)).toThrow(/cyclic/);

    const cyclicObject: Record<string, JsonValue> = {};
    cyclicObject.self = cyclicObject;
    expect(() => canonicalize(cyclicObject)).toThrow(/cyclic/);
  });
});

describe('isJsonValue', () => {
  it('accepts every generated JSON value', () => {
    fc.assert(
      fc.property(jsonArb(), (value) => {
        expect(isJsonValue(value)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('accepts valid JSON values including shared references', () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(-0)).toBe(true);
    expect(isJsonValue([1, [2, { a: null }]])).toBe(true);
    const shared = { a: 1 };
    expect(isJsonValue({ x: shared, y: shared })).toBe(true);
  });

  it('rejects non-JSON values', () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(() => {})).toBe(false);
    expect(isJsonValue(Symbol('x'))).toBe(false);
    expect(isJsonValue(BigInt(1))).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue({ a: undefined })).toBe(false);
    expect(isJsonValue([1, undefined])).toBe(false);
  });

  it('rejects cyclic references', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(isJsonValue(cyclic)).toBe(false);
  });

  it('rejects nesting beyond MAX_JSON_DEPTH', () => {
    expect(isJsonValue(wrapArrays(1, MAX_JSON_DEPTH + 10))).toBe(false);
    expect(isJsonValue(wrapArrays(1, MAX_JSON_DEPTH - 1))).toBe(true);
  });
});
