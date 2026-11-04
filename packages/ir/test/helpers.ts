import fc from 'fast-check';
import type { JsonValue } from '../src/types';

export function jsonArb(): fc.Arbitrary<JsonValue> {
  return fc.jsonValue().map((value): JsonValue => JSON.parse(JSON.stringify(value)));
}

export function reverseKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).reverse();
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of entries) {
      Object.defineProperty(out, key, {
        value: reverseKeys(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function wrapArrays(value: JsonValue, times: number): JsonValue {
  let current = value;
  for (let i = 0; i < times; i++) {
    current = [current];
  }
  return current;
}
