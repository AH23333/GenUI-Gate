import { canonicalize } from './json';
import { sha256Hex } from './sha256';
import type { IRNode, JsonValue } from './types';

export function canonicalHash(value: JsonValue): string {
  return sha256Hex(canonicalize(value));
}

export function specHash(ir: IRNode): string {
  return canonicalHash(ir as unknown as JsonValue);
}
