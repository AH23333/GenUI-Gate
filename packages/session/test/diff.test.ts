import type { IRNode, JsonObject } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffTrees } from '../src/diff';

function node(
  id: string,
  type: string,
  props: JsonObject = {},
  slots: Record<string, IRNode[]> = {},
): IRNode {
  return { id, type, props, slots };
}

function nodeCount(root: IRNode): number {
  let count = 0;
  const stack: IRNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    for (const children of Object.values(current.slots)) {
      for (const child of children) stack.push(child);
    }
  }
  return count;
}

function treeArbitrary(maxDepth: number): fc.Arbitrary<IRNode> {
  const makeNode = (slotsArb: fc.Arbitrary<Record<string, IRNode[]>>): fc.Arbitrary<IRNode> =>
    fc.record({
      id: fc.nat({ max: 999999 }).map((n) => `n${n}`),
      type: fc.constantFrom('Text', 'Row', 'Button'),
      props: fc.dictionary(fc.constantFrom('a', 'b', 'c', 'k'), fc.nat({ max: 99 })),
      slots: slotsArb,
    });
  if (maxDepth <= 0) {
    return makeNode(fc.constant({}));
  }
  const childArb = treeArbitrary(maxDepth - 1);
  return makeNode(
    fc.dictionary(
      fc.constantFrom('default', 'footer'),
      fc.array(childArb, { maxLength: 2 }),
    ),
  );
}

describe('diffTrees (v2 §9.1 提案 diff，路径键控)', () => {
  it('previous === null：全部 added（含 <root>），无 removed/changed/unchanged', () => {
    const next = node('root', 'Column', { gap: 8 }, {
      default: [node('c1', 'Text', { content: 'hi' })],
    });
    const diff = diffTrees(null, next);
    expect(diff.added).toEqual(['<root>', '<root>/slots.default[0]']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it('同树 diff：全 unchanged，计数 = 节点总数', () => {
    const tree = node('root', 'Column', { gap: 8 }, {
      default: [
        node('c1', 'Text', { content: 'hi' }),
        node('c2', 'Button', { label: 'ok' }, { footer: [node('c3', 'Text')] }),
      ],
    });
    const diff = diffTrees(tree, tree);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(nodeCount(tree));
  });

  it('路径格式：`<root>/slots.<name>[<idx>]`，槽名与索引按文档序展开', () => {
    const tree = node('root', 'Column', {}, {
      default: [node('c1', 'Text'), node('c2', 'Text')],
      footer: [node('f1', 'Text')],
    });
    const diff = diffTrees(null, tree);
    expect(diff.added).toEqual([
      '<root>',
      '<root>/slots.default[0]',
      '<root>/slots.default[1]',
      '<root>/slots.footer[0]',
    ]);
  });

  it('同路径 type 变化 → changed', () => {
    const previous = node('root', 'Column', {}, { default: [node('c1', 'Text')] });
    const next = node('root', 'Column', {}, { default: [node('c1', 'Row')] });
    const diff = diffTrees(previous, next);
    expect(diff.changed).toEqual(['<root>/slots.default[0]']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it('同路径 props 变化 → changed；props 键序无关（canonical 比较）→ unchanged', () => {
    const previous = node('root', 'Text', { a: 1, b: 2 });
    const changed = node('root', 'Text', { a: 1, b: 3 });
    const reordered = node('root', 'Text', { b: 2, a: 1 });
    expect(diffTrees(previous, changed).changed).toEqual(['<root>']);
    expect(diffTrees(previous, reordered).changed).toEqual([]);
    expect(diffTrees(previous, reordered).unchangedCount).toBe(1);
  });

  it('仅 id 不同（内容同 type+props）→ unchanged（内容基准，非 id 基准）', () => {
    const previous = node('a', 'Text', { content: 'x' });
    const next = node('b', 'Text', { content: 'x' });
    expect(diffTrees(previous, next).unchangedCount).toBe(1);
  });

  it('子树新增 → added；子树移除 → removed', () => {
    const previous = node('root', 'Column', {}, { default: [node('c1', 'Text')] });
    const next = node('root', 'Column', {}, { default: [node('c1', 'Text'), node('c2', 'Row', {}, { footer: [node('g', 'Text')] })] });
    const added = diffTrees(previous, next);
    expect(added.added).toEqual(['<root>/slots.default[1]', '<root>/slots.default[1]/slots.footer[0]']);
    expect(added.removed).toEqual([]);
    const removed = diffTrees(next, previous);
    expect(removed.removed).toEqual(['<root>/slots.default[1]', '<root>/slots.default[1]/slots.footer[0]']);
    expect(removed.added).toEqual([]);
  });

  it('确定性 + 划分不变量（200 runs）', () => {
    fc.assert(
      fc.property(treeArbitrary(2), treeArbitrary(2), (previous, next) => {
        const diff = diffTrees(previous, next);
        // 确定性：同一对树两次 diff 结果深度相等
        expect(diff).toEqual(diffTrees(previous, next));
        // 划分不变量：added+changed+unchanged = next 节点数；removed+changed+unchanged = previous 节点数
        expect(diff.added.length + diff.changed.length + diff.unchangedCount).toBe(nodeCount(next));
        expect(diff.removed.length + diff.changed.length + diff.unchangedCount).toBe(nodeCount(previous));
        expect(diffTrees(null, next).added.length).toBe(nodeCount(next));
      }),
      { numRuns: 200 },
    );
  }, 30000);
});
