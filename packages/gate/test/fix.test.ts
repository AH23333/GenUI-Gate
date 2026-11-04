import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { specHash } from '@genui/ir';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_FIX_CHAIN,
  MAX_FIX_PATH_DEPTH,
  applyFixes,
  gate,
  parseNodePath,
  projectVerdict,
  type FixRequest,
} from '../src/index';

// ---------------------------------------------------------------------------
// M1 task 1.3 — fix stage (v2 §6.1/§6.4/§6.6) + gate idempotency (§15.0).
// ---------------------------------------------------------------------------

function makeNode(id: string, type: string, props: JsonObject, slots: Record<string, IRNode[]>): IRNode {
  return { id, type, props, slots };
}

/** 完备修复器样例：缺失 label 时补全，已存在则拒绝（返回 null，fail-closed）。 */
function ensureLabel(node: IRNode): { node: IRNode; before: JsonValue; after: JsonValue } | null {
  if (node.props['label'] !== undefined) return null;
  return {
    node: { ...node, props: { ...node.props, label: 'auto' } },
    before: null,
    after: 'auto',
  };
}

/** 永续修复器样例（测链预算用）：props.n 计数器 +1，总是可应用。 */
function bump(node: IRNode): { node: IRNode; before: JsonValue; after: JsonValue } {
  const previous = typeof node.props['n'] === 'number' ? node.props['n'] : 0;
  const next = previous + 1;
  return {
    node: { ...node, props: { ...node.props, n: next } },
    before: previous,
    after: next,
  };
}

const FIXERS = { ensureLabel, bump };

let root: IRNode;
let snapshot: IRNode;

beforeEach(() => {
  root = makeNode('r', 'Row', { title: 'menu' }, {
    content: [
      makeNode('t1', 'Text', { text: 'hello' }, {}),
      makeNode('b1', 'Button', { onClick: 'noop' }, {
        icon: [makeNode('i1', 'Icon', { name: 'star' }, {})],
      }),
    ],
  });
  snapshot = structuredClone(root);
});

function request(partial: Partial<FixRequest> & { nodePath: string }): FixRequest {
  return {
    ruleId: partial.ruleId ?? 'test.needs-label',
    severity: partial.severity ?? 'warn',
    nodePath: partial.nodePath,
    fixer: partial.fixer ?? 'ensureLabel',
    message: partial.message ?? 'component needs a label',
  };
}

describe('parseNodePath', () => {
  it('parses the root path to zero segments', () => {
    expect(parseNodePath('<root>')).toEqual([]);
  });

  it('parses nested slot paths in order', () => {
    expect(parseNodePath('<root>/slots.content[1]/slots.icon[0]')).toEqual([
      { slot: 'content', index: 1 },
      { slot: 'icon', index: 0 },
    ]);
  });

  it('rejects malformed prefixes, indices and slot names', () => {
    expect(parseNodePath('root')).toBeNull();
    expect(parseNodePath('<root>/content[0]')).toBeNull();
    expect(parseNodePath('<root>/slots.a[x]')).toBeNull();
    expect(parseNodePath('<root>/slots.a[0')).toBeNull();
    expect(parseNodePath('<root>/slots.a[b][0]')).toBeNull();
  });
});

describe('applyFixes', () => {
  it('applies a fixer at the root and records before/after in the trace', () => {
    const result = applyFixes(root, [request({ nodePath: '<root>' })], FIXERS);
    expect(result.applied).toBe(1);
    expect(result.ir.props['label']).toBe('auto');
    expect(result.ir.type).toBe('Row');
    expect(result.trace).toEqual([
      {
        ruleId: 'test.needs-label',
        severity: 'warn',
        action: 'transform',
        nodePath: '<root>',
        message: 'component needs a label',
        before: null,
        after: 'auto',
      },
    ]);
  });

  it('applies a fixer at a nested path and leaves the input tree untouched', () => {
    const result = applyFixes(root, [request({ nodePath: '<root>/slots.content[1]/slots.icon[0]' })], FIXERS);
    expect(result.applied).toBe(1);
    expect(result.ir.slots['content']![1]!.slots['icon']![0]!.props['label']).toBe('auto');
    // 输入不可变：原树与快照全等，且未被共享修改
    expect(root).toEqual(snapshot);
    expect(result.ir.props['label']).toBeUndefined();
    expect(result.ir.slots['content']![0]!.props['label']).toBeUndefined();
    // 结构共享：未修改的兄弟子树保持引用相等
    expect(result.ir.slots['content']![0]).toBe(root.slots['content']![0]);
  });

  it('applies multiple fixes sequentially to distinct nodes', () => {
    const result = applyFixes(
      root,
      [
        request({ nodePath: '<root>/slots.content[0]' }),
        request({ nodePath: '<root>/slots.content[1]' }),
      ],
      FIXERS,
    );
    expect(result.applied).toBe(2);
    expect(result.ir.slots['content']![0]!.props['label']).toBe('auto');
    expect(result.ir.slots['content']![1]!.props['label']).toBe('auto');
    expect(result.trace).toHaveLength(2);
    expect(result.trace.every((entry) => entry.action === 'transform')).toBe(true);
  });

  it('degrades to error+block for an unknown fixer without touching the tree', () => {
    const result = applyFixes(root, [request({ nodePath: '<root>', fixer: 'nope' })], FIXERS);
    expect(result.applied).toBe(0);
    expect(result.ir).toBe(root);
    expect(result.trace).toEqual([
      {
        ruleId: 'test.needs-label',
        severity: 'error',
        action: 'block',
        nodePath: '<root>',
        message: 'component needs a label; unknown fixer "nope"',
      },
    ]);
  });

  it('degrades to block when the fixer refuses (completeness fail-closed)', () => {
    const result = applyFixes(root, [request({ nodePath: '<root>' }), request({ nodePath: '<root>' })], FIXERS);
    expect(result.applied).toBe(1);
    expect(result.ir.props['label']).toBe('auto');
    expect(result.trace[1]).toMatchObject({
      action: 'block',
      nodePath: '<root>',
      message: 'component needs a label; fixer "ensureLabel" not applicable',
    });
  });

  it('degrades to block for stale paths', () => {
    const result = applyFixes(
      root,
      [
        request({ nodePath: '<root>/slots.content[9]' }),
        request({ nodePath: '<root>/slots.missing[0]' }),
      ],
      FIXERS,
    );
    expect(result.applied).toBe(0);
    expect(result.ir).toBe(root);
    expect(result.trace).toHaveLength(2);
    expect(result.trace.every((entry) => entry.action === 'block')).toBe(true);
  });

  it('degrades to block for paths deeper than the recursion guard', () => {
    let deep: IRNode = makeNode('d0', 'Text', {}, {});
    for (let i = 1; i <= MAX_FIX_PATH_DEPTH + 1; i++) {
      deep = makeNode(`d${i}`, 'Row', {}, { c: [deep] });
    }
    let path = '<root>';
    for (let i = 0; i <= MAX_FIX_PATH_DEPTH + 1; i++) {
      path = `${path}/slots.c[0]`;
    }
    // path 段数 = MAX_FIX_PATH_DEPTH + 2 > 护栏
    const tooDeep = applyFixes(deep, [request({ nodePath: path })], FIXERS);
    expect(tooDeep.applied).toBe(0);
    expect(tooDeep.trace[0]!.action).toBe('block');
    expect(tooDeep.trace[0]!.message).toContain('unusable fix path');

    // 恰好 32 段（护栏边界内）可正常应用
    const atLimit = path.slice(0, path.length - '/slots.c[0]'.length * 2);
    const result = applyFixes(deep, [request({ nodePath: atLimit })], FIXERS);
    expect(result.applied).toBe(1);
    expect(result.trace[0]!.action).toBe('transform');
  });

  it('rejects the whole batch when requests exceed MAX_FIX_CHAIN (v2 §6.6, all-or-nothing for §15.0)', () => {
    const requests: FixRequest[] = [];
    for (let i = 0; i < MAX_FIX_CHAIN + 1; i++) {
      requests.push(request({ nodePath: '<root>', fixer: 'bump', message: 'chain fill' }));
    }
    const result = applyFixes(root, requests, FIXERS);
    expect(result.applied).toBe(0);
    expect(result.ir).toBe(root);
    expect(result.trace).toHaveLength(MAX_FIX_CHAIN + 1);
    expect(result.trace.filter((entry) => entry.action === 'transform')).toHaveLength(0);
    for (const entry of result.trace) {
      expect(entry.action).toBe('block');
      expect(entry.message).toContain(`fix chain exceeded ${MAX_FIX_CHAIN} applications`);
    }
  });

  it('applies exactly MAX_FIX_CHAIN requests at the boundary without degradation', () => {
    const requests: FixRequest[] = [];
    for (let i = 0; i < MAX_FIX_CHAIN; i++) {
      requests.push(request({ nodePath: '<root>', fixer: 'bump', message: 'chain fill' }));
    }
    const result = applyFixes(root, requests, FIXERS);
    expect(result.applied).toBe(MAX_FIX_CHAIN);
    expect(result.ir.props['n']).toBe(MAX_FIX_CHAIN);
    expect(result.trace).toHaveLength(MAX_FIX_CHAIN);
    expect(result.trace.every((entry) => entry.action === 'transform')).toBe(true);
  });

  it('keeps the last before/after of the chain consistent (budget overflow trace)', () => {
    const result = applyFixes(root, [request({ nodePath: '<root>', fixer: 'bump', message: 'b' })], FIXERS);
    expect(result.trace[0]!.before).toBe(0);
    expect(result.trace[0]!.after).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// v2 §15.0 — gate 幂等性属性：IR 不动点 + verdict 投影。
// gate 尚未内联 fix（1.4 接线 policy 后生效），此属性是接线后的回归哨兵。
// ---------------------------------------------------------------------------

const TYPES = ['Text', 'Row', 'Column', 'Button', 'Card'];

const valueArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 8 }),
);

interface RawNode {
  type: string;
  props: Record<string, JsonValue>;
  slots: Record<string, RawNode[]>;
}

function rawNodeArb(depth: number): fc.Arbitrary<RawNode> {
  if (depth <= 0) {
    return fc.record({ type: fc.constantFrom(...TYPES), props: fc.dictionary(fc.string({ maxLength: 6 }), valueArb), slots: fc.constant({}) });
  }
  return fc.record({
    type: fc.constantFrom(...TYPES),
    props: fc.dictionary(fc.string({ maxLength: 6 }), valueArb),
    slots: fc.dictionary(fc.string({ maxLength: 6 }), fc.array(rawNodeArb(depth - 1), { maxLength: 2 })),
  });
}

function materialize(raw: RawNode, allocId: () => string): IRNode {
  const slots: Record<string, IRNode[]> = {};
  for (const slotName of Object.keys(raw.slots)) {
    slots[slotName] = raw.slots[slotName]!.map((child) => materialize(child, allocId));
  }
  return { id: allocId(), type: raw.type, props: raw.props, slots };
}

function irArb(): fc.Arbitrary<IRNode> {
  return rawNodeArb(3).map((raw) => {
    let counter = 0;
    return materialize(raw, () => `n${counter++}`);
  });
}

describe('gate idempotency (v2 §15.0)', () => {
  it('gate(gate(x).ir) keeps the IR fixed point and projects the verdict', () => {
    const property = fc.property(irArb(), (ir) => {
      const first = gate(ir);
      const second = gate(first.ir);
      expect(specHash(second.ir)).toBe(specHash(first.ir));
      expect(second.verdict).toBe(projectVerdict(first.verdict));
    });
    fc.assert(property, { numRuns: 100 });
  }, 20000);
});
