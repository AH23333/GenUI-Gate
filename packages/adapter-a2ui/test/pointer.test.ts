import { describe, expect, it } from 'vitest';
import { PointerError, pointerGet, pointerSet, pointerTokens } from '../src/pointer';

function model(): Record<string, unknown> {
  return {
    user: { name: 'Ada', tags: ['x', 'y'] },
    items: [
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ],
    'a/b': 'escaped',
    'c~d': 'tilde',
  };
}

describe('pointerTokens', () => {
  it('splits and unescapes tokens', () => {
    expect(pointerTokens('')).toEqual([]);
    expect(pointerTokens('/user/name')).toEqual(['user', 'name']);
    expect(pointerTokens('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(pointerTokens('/items/0/label')).toEqual(['items', '0', 'label']);
  });

  it('rejects non-pointer strings', () => {
    expect(() => pointerTokens('user/name')).toThrow(PointerError);
    expect(() => pointerTokens('noslash')).toThrow(PointerError);
  });
});

describe('pointerGet', () => {
  it('reads objects, arrays and the whole document', () => {
    const root = model();
    expect(pointerGet(root, '/user/name')).toBe('Ada');
    expect(pointerGet(root, '/items/1/label')).toBe('two');
    expect(pointerGet(root, '/a~1b')).toBe('escaped');
    expect(pointerGet(root, '/c~0d')).toBe('tilde');
    expect(pointerGet(root, '')).toBe(root);
  });

  it('returns undefined for missing paths', () => {
    expect(pointerGet(model(), '/missing/key')).toBeUndefined();
    expect(pointerGet(model(), '/user/name/deep')).toBeUndefined();
  });
});

describe('pointerSet', () => {
  it('replaces existing values', () => {
    const root = model();
    pointerSet(root, '/user/name', 'Grace');
    expect(root['user']).toEqual({ name: 'Grace', tags: ['x', 'y'] });
  });

  it('upserts nested objects that do not exist yet', () => {
    const root: Record<string, unknown> = {};
    pointerSet(root, '/contact/email', 'a@b.c');
    expect(root['contact']).toEqual({ email: 'a@b.c' });
  });

  it('replaces values inside arrays', () => {
    const root = model();
    pointerSet(root, '/items/1', { id: 3, label: 'three' });
    expect((root['items'] as Array<Record<string, unknown>>)[1]).toEqual({ id: 3, label: 'three' });
    expect((root['items'] as unknown[]).length).toBe(2);
  });

  it('appends past the array end by padding with null', () => {
    const root = model();
    pointerSet(root, '/items/3', { id: 4, label: 'four' });
    const items = root['items'] as unknown[];
    expect(items.length).toBe(4);
    expect(items[2]).toBeNull();
    expect(items[3]).toEqual({ id: 4, label: 'four' });
  });

  it('deletes the key when value is null', () => {
    const root = model();
    pointerSet(root, '/user/name', null);
    expect(root['user']).toEqual({ tags: ['x', 'y'] });
    pointerSet(root, '/user', null);
    expect(root).not.toHaveProperty('user');
  });

  it('splices arrays on null delete', () => {
    const root = model();
    pointerSet(root, '/items/0', null);
    const items = root['items'] as unknown[];
    expect(items.length).toBe(1);
    expect(items[0]).toEqual({ id: 2, label: 'two' });
  });

  it('creates intermediate containers over nulls', () => {
    const root: Record<string, unknown> = { a: null };
    pointerSet(root, '/a/b/c', 1);
    expect(root['a']).toEqual({ b: { c: 1 } });
  });

  it('rejects invalid targets instead of throwing raw TypeError', () => {
    const root = model();
    expect(() => pointerSet(root, '/user/name/first', 'x')).toThrow(PointerError);
    expect(() => pointerSet(root, '/items/notanindex', 1)).toThrow(PointerError);
    expect(() => pointerSet(root, '', 'x')).toThrow(PointerError);
  });

  it('never pollutes Object.prototype through a "__proto__" pointer (PIT-009 regression)', () => {
    const doc: Record<string, unknown> = {};
    pointerSet(doc, '/__proto__/polluted', 'x');
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(doc, '__proto__')).toBe(true);
    expect(pointerGet(doc, '/__proto__/polluted')).toBe('x');

    const deleted: Record<string, unknown> = {};
    pointerSet(deleted, '/__proto__/polluted', 'x');
    pointerSet(deleted, '/__proto__/polluted', null);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('treats inherited properties as absent and writes own keys only (PIT-009 regression)', () => {
    const doc: Record<string, unknown> = {};
    expect(pointerGet(doc, '/toString')).toBeUndefined();
    expect(pointerGet(doc, '/constructor')).toBeUndefined();
    expect(pointerGet(doc, '/hasOwnProperty')).toBeUndefined();

    pointerSet(doc, '/toString/', 0);
    expect(Object.hasOwn(doc, 'toString')).toBe(true);
    expect(pointerGet(doc, '/toString/')).toBe(0);

    pointerSet(doc, '/a/constructor', 'own');
    expect(Object.prototype).not.toHaveProperty('a');
    expect(pointerGet(doc, '/a/constructor')).toBe('own');
  });
});
