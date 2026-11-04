import type { IRNode } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { adaptA2UI, A2UISession } from '../src/adapter';
import { parseA2UISpec } from '../src/parse';
import { PointerError, pointerGet, pointerSet, pointerTokens } from '../src/pointer';
import type { A2UIMessageKind } from '../src/types';

// ---------------------------------------------------------------------------
// Deep-testing properties (开发指南 §3.1): determinism, round-trip, structure
// preservation — every property >= 100 runs.
// ---------------------------------------------------------------------------

const TYPES = fc.constantFrom('Text', 'Row', 'Column', 'Button', 'Card');

interface GenTree {
  type: string;
  children: GenTree[];
}

function treeArbitrary(maxDepth: number): fc.Arbitrary<GenTree> {
  if (maxDepth <= 0) {
    return fc.record({ type: TYPES, children: fc.constant([]) });
  }
  return fc.record({
    type: TYPES,
    children: fc.array(treeArbitrary(maxDepth - 1), { maxLength: 3 }),
  });
}

interface Flattened {
  spec: string;
  preorderIds: string[];
  rootType: string;
}

function flatten(tree: GenTree): Flattened {
  const components: Array<Record<string, unknown>> = [];
  const preorderIds: string[] = [];
  let counter = 0;
  const visit = (node: GenTree, id: string): void => {
    preorderIds.push(id);
    const childIds: string[] = [];
    for (let i = 0; i < node.children.length; i++) {
      counter += 1;
      childIds.push(`n${counter}`);
    }
    const entry: Record<string, unknown> = { id, component: node.type };
    if (childIds.length > 0) entry['children'] = childIds;
    components.push(entry);
    for (let i = 0; i < node.children.length; i++) {
      visit(node.children[i]!, childIds[i]!);
    }
  };
  visit(tree, 'root');
  return {
    spec: JSON.stringify({
      version: '1.0',
      createSurface: { surfaceId: 's', components },
    }),
    preorderIds,
    rootType: tree.type,
  };
}

const validSpec = treeArbitrary(4).map(flatten);

function preorderIdsOf(root: IRNode): string[] {
  const out: string[] = [];
  const stack: IRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node.id);
    const children = node.slots['children'] ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return out;
}

const KINDS: A2UIMessageKind[] = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
];

const payloadArb = fc.dictionary(
  fc.string({ maxLength: 8 }),
  fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.string({ maxLength: 8 }), fc.boolean(), fc.constant(null)),
);

const envelopeArb = fc
  .record({
    kind: fc.constantFrom(...KINDS),
    payload: payloadArb,
    version: fc.option(fc.constantFrom('1.0', 'v0.9'), { nil: undefined }),
  })
  .map(({ kind, payload, version }) => {
    const envelope: Record<string, unknown> = { [kind]: payload };
    if (version !== undefined) envelope['version'] = version;
    return envelope;
  });

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

describe('adapter property tests', () => {
  it('adapts a generated valid spec cleanly, preserving size, order and shape', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        const result = adaptA2UI(gen.spec);
        expect(result.issues).toEqual([]);
        expect(result.surfaces.length).toBe(1);
        const surface = result.surfaces[0]!;
        expect(surface.componentCount).toBe(gen.preorderIds.length);
        expect(surface.ir).not.toBeNull();
        expect(surface.ir!.id).toBe('root');
        expect(surface.ir!.type).toBe(gen.rootType);
        expect(preorderIdsOf(surface.ir!)).toEqual(gen.preorderIds);
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic: identical input, byte-identical result', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        expect(JSON.stringify(adaptA2UI(gen.spec))).toBe(JSON.stringify(adaptA2UI(gen.spec)));
      }),
      { numRuns: 100 },
    );
  });

  it('two independent sessions produce identical snapshots for the same messages', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        const messages = parseA2UISpec(gen.spec).messages;
        const a = new A2UISession();
        const b = new A2UISession();
        a.applyAll(messages);
        b.applyAll(messages);
        const snapA = a.snapshot();
        const snapB = b.snapshot();
        expect(JSON.stringify(snapA.surfaces)).toBe(JSON.stringify(snapB.surfaces));
        expect(snapA.issues).toEqual(snapB.issues);
      }),
      { numRuns: 100 },
    );
  });

  it('resync (reset + replay) rebuilds byte-identical state', () => {
    fc.assert(
      fc.property(validSpec, (gen) => {
        const messages = parseA2UISpec(gen.spec).messages;
        const session = new A2UISession();
        session.applyAll(messages);
        const first = session.snapshot();
        session.reset();
        session.applyAll(messages);
        const second = session.snapshot();
        expect(JSON.stringify(second.surfaces)).toBe(JSON.stringify(first.surfaces));
        expect(second.issues).toEqual(first.issues);
      }),
      { numRuns: 100 },
    );
  });

  it('JSONL round-trips arbitrary valid envelopes (kind, payload, version, order)', () => {
    fc.assert(
      fc.property(fc.array(envelopeArb, { minLength: 1, maxLength: 20 }), (envelopes) => {
        const jsonl = envelopes.map((e) => JSON.stringify(e)).join('\n');
        const first = parseA2UISpec(jsonl);
        expect(first.issues).toEqual([]);
        expect(first.messages.length).toBe(envelopes.length);
        for (let i = 0; i < envelopes.length; i++) {
          const envelope = envelopes[i]!;
          const message = first.messages[i]!;
          const kind = Object.keys(envelope).find((k) => (KINDS as string[]).includes(k))!;
          expect(message.kind).toBe(kind);
          expect(message.payload).toEqual(envelope[kind]);
          expect(message.version).toBe(envelope['version']);
        }
        const second = parseA2UISpec(jsonl);
        expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
      }),
      { numRuns: 100 },
    );
  });

  it('RFC 6901 token escaping round-trips arbitrary tokens', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 20 }), (tokens) => {
        const pointer = tokens.length === 0 ? '' : `/${tokens.map(escapeToken).join('/')}`;
        expect(pointerTokens(pointer)).toEqual(tokens);
      }),
      { numRuns: 100 },
    );
  });

  it('pointerSet followed by pointerGet returns the value for arbitrary object paths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 8 }),
        fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.string({ maxLength: 10 }), fc.boolean()),
        (tokens, value) => {
          const doc: Record<string, unknown> = {};
          const pointer = `/${tokens.map(escapeToken).join('/')}`;
          pointerSet(doc, pointer, value);
          expect(pointerGet(doc, pointer)).toEqual(value);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects pointers with more than 256 tokens', () => {
    const tokens = Array.from({ length: 300 }, (_, i) => `t${i}`);
    expect(() => pointerTokens(`/${tokens.join('/')}`)).toThrow(PointerError);
  });

  it('adapts a 10k-deep child chain without stack overflow or issues', () => {
    const components: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10000; i++) {
      const entry: Record<string, unknown> = { id: i === 0 ? 'root' : `n${i}`, component: 'Card' };
      if (i < 9999) entry['child'] = `n${i + 1}`;
      components.push(entry);
    }
    const spec = JSON.stringify({ version: '1.0', createSurface: { surfaceId: 's', components } });
    const result = adaptA2UI(spec);
    expect(result.issues).toEqual([]);
    let count = 0;
    const stack: IRNode[] = [result.surfaces[0]!.ir!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      count += 1;
      for (const child of node.slots['child'] ?? []) stack.push(child);
    }
    expect(count).toBe(10000);
  });

  it('detects a cycle closing a 10k-deep chain without hanging', () => {
    const components: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10000; i++) {
      const entry: Record<string, unknown> = { id: i === 0 ? 'root' : `n${i}`, component: 'Card' };
      entry['child'] = i === 9999 ? 'root' : `n${i + 1}`;
      components.push(entry);
    }
    const spec = JSON.stringify({ version: '1.0', createSurface: { surfaceId: 's', components } });
    const result = adaptA2UI(spec);
    expect(result.issues.map((i) => i.code)).toEqual(['child-cycle']);
    let count = 0;
    const stack: IRNode[] = [result.surfaces[0]!.ir!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      count += 1;
      for (const child of node.slots['child'] ?? []) stack.push(child);
    }
    expect(count).toBe(10000);
  });
});
