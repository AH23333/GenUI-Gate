import type { JsonObject, JsonValue } from './types';

export const MAX_JSON_DEPTH = 256;

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(reason: string, path: string) {
    super(`canonicalization failed at ${path || '<root>'}: ${reason}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

function isPlainObjectOrArray(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type EnterTask = { kind: 'enter'; value: unknown; depth: number };
type ExitTask = { kind: 'exit'; container: object };
type Task = EnterTask | ExitTask;

export function isJsonValue(value: unknown): boolean {
  const stack: Task[] = [{ kind: 'enter', value, depth: 0 }];
  const onPath = new Set<object>();
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.kind === 'exit') {
      onPath.delete(task.container);
      continue;
    }
    const { value: current, depth } = task;
    if (current === null) continue;
    if (typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (depth >= MAX_JSON_DEPTH) return false;
    if (!isPlainObjectOrArray(current)) return false;
    if (onPath.has(current)) return false;
    onPath.add(current);
    stack.push({ kind: 'exit', container: current });
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push({ kind: 'enter', value: current[i], depth: depth + 1 });
      }
    } else {
      const source = current as Record<string, unknown>;
      const keys = Object.keys(source);
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push({ kind: 'enter', value: source[keys[i]!], depth: depth + 1 });
      }
    }
  }
  return true;
}

type Frame =
  | {
      kind: 'array';
      values: JsonValue[];
      index: number;
      path: string;
      container: object;
    }
  | {
      kind: 'object';
      source: JsonObject;
      keys: string[];
      index: number;
      path: string;
      container: object;
    };

export function canonicalize(root: JsonValue): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  const onPath = new Set<object>();

  function emit(value: JsonValue, path: string): void {
    if (value === null) {
      out.push('null');
      return;
    }
    if (typeof value === 'string') {
      out.push(JSON.stringify(value));
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError('number is not finite', path);
      }
      out.push(String(value));
      return;
    }
    if (typeof value === 'boolean') {
      out.push(value ? 'true' : 'false');
      return;
    }
    if (typeof value !== 'object') {
      throw new CanonicalizationError(`value of type ${typeof value} is not a JSON value`, path);
    }
    if (!isPlainObjectOrArray(value)) {
      throw new CanonicalizationError('only plain objects and arrays are supported', path);
    }
    if (stack.length >= MAX_JSON_DEPTH) {
      throw new CanonicalizationError(`depth exceeds ${MAX_JSON_DEPTH}`, path);
    }
    if (onPath.has(value)) {
      throw new CanonicalizationError('cyclic reference', path);
    }
    onPath.add(value);
    if (Array.isArray(value)) {
      stack.push({ kind: 'array', values: value, index: 0, path, container: value });
      out.push('[');
    } else {
      const source = value as JsonObject;
      stack.push({
        kind: 'object',
        source,
        keys: Object.keys(source).sort(),
        index: 0,
        path,
        container: value,
      });
      out.push('{');
    }
  }

  emit(root, '<root>');

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === 'array') {
      if (frame.index >= frame.values.length) {
        out.push(']');
        stack.pop();
        onPath.delete(frame.container);
        continue;
      }
      if (frame.index > 0) out.push(',');
      emit(frame.values[frame.index]!, `${frame.path}[${frame.index}]`);
      frame.index += 1;
    } else {
      if (frame.index >= frame.keys.length) {
        out.push('}');
        stack.pop();
        onPath.delete(frame.container);
        continue;
      }
      const key = frame.keys[frame.index]!;
      if (frame.index > 0) out.push(',');
      out.push(`${JSON.stringify(key)}:`);
      emit(frame.source[key]!, `${frame.path}.${key}`);
      frame.index += 1;
    }
  }

  return out.join('');
}
