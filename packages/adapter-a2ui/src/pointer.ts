const POINTER_MAX_TOKENS = 256;

export class PointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointerError';
  }
}

export function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new PointerError(`pointer must be empty or start with "/": ${pointer}`);
  }
  const raw = pointer.slice(1).split('/');
  if (raw.length > POINTER_MAX_TOKENS) {
    throw new PointerError(`pointer has more than ${POINTER_MAX_TOKENS} tokens: ${pointer}`);
  }
  return raw.map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

interface Cursor {
  container: Record<string, unknown> | unknown[];
  key: string;
}

function toIndex(token: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : undefined;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/**
 * Resolves the parent container and final key for `tokens` inside `root`,
 * creating intermediate plain objects along the way (upsert semantics).
 * Own-property semantics throughout: inherited properties never act as
 * intermediate containers, and intermediates are created via defineProperty
 * so an "__proto__" token becomes an own JSON key, never a prototype swap.
 */
function resolve(root: Record<string, unknown>, tokens: string[]): Cursor {
  let container: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    let ensured: unknown;
    if (Array.isArray(container)) {
      const index = toIndex(token);
      if (index === undefined) {
        throw new PointerError(`token "${token}" is not a valid array index`);
      }
      if (container[index] === undefined || container[index] === null) {
        container[index] = {};
      }
      ensured = container[index];
    } else {
      const existing = Object.hasOwn(container, token) ? container[token] : undefined;
      if (existing === undefined || existing === null) {
        defineOwn(container, token, {});
      }
      ensured = Object.hasOwn(container, token) ? container[token] : undefined;
    }
    if (!isContainer(ensured)) {
      throw new PointerError(`path segment ${tokens.slice(0, i + 1).join('/')} is not an object or array`);
    }
    container = ensured;
  }
  return { container, key: tokens[tokens.length - 1]! };
}

/**
 * RFC 6901 evaluation; returns undefined when the path does not resolve.
 * Own-property semantics: a JSON document has no prototype chain, so
 * inherited properties (toString, constructor, ...) never resolve.
 */
export function pointerGet(root: Record<string, unknown>, pointer: string): unknown {
  const tokens = pointerTokens(pointer);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      current = current[toIndex(token) ?? -1];
      continue;
    }
    const record = current as Record<string, unknown>;
    current = Object.hasOwn(record, token) ? record[token] : undefined;
  }
  return current;
}

/**
 * Assigns an own property without ever invoking the `__proto__` setter
 * (bracket assignment on plain objects hijacks the prototype; PIT-009).
 */
function defineOwn(container: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * RFC 6901-style upsert. Replaces (or creates) the value at `pointer`.
 * When `value` is null the key at `pointer` is removed (A2UI null-means-delete).
 * Own-property semantics: writes never reach the prototype chain (PIT-009).
 */
export function pointerSet(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const tokens = pointerTokens(pointer);
  if (tokens.length === 0) {
    throw new PointerError('cannot replace the whole document through pointerSet');
  }
  const { container, key } = resolve(root, tokens);
  if (Array.isArray(container)) {
    const index = toIndex(key);
    if (index === undefined) {
      throw new PointerError(`token "${key}" is not a valid array index`);
    }
    if (value === null) {
      container.splice(index, 1);
      return;
    }
    if (index > container.length) {
      for (let i = container.length; i < index; i++) container[i] = null;
    }
    container[index] = value;
    return;
  }
  if (value === null) {
    if (Object.hasOwn(container, key)) delete container[key];
    return;
  }
  defineOwn(container, key, value);
}
