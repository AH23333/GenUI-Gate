import { canonicalize } from '@genui/ir';
import type { IRNode } from '@genui/ir';

/**
 * 提案 diff（v2 §9.1：stage 时生成 IR′ + diff）。
 *
 * 语义（MVP，KAN-025）：路径键控的结构 diff——
 * - 路径 = gate nodePath 约定 `<root>/slots.<name>[<idx>]`；
 * - added：IR′ 中存在、基线中不存在的路径；
 * - removed：基线中存在、IR′ 中不存在的路径；
 * - changed：同路径但组件 type 或 props 规范化文本不同；
 * - unchangedCount：同路径且 type/props 全等的信息计数。
 *
 * 位置键控的已知局限：兄弟节点插入会使后续兄弟的索引路径整体偏移（计为
 * added+removed 而非移动），预览语义偏保守但确定。语义级移动检测（按 id）留给
 * devtools 增强，不进核心。列表按文档序（插入序）排列，确定性。
 */
export interface ProposalDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchangedCount: number;
}

interface NodeInfo {
  readonly type: string;
  readonly propsCanonical: string;
}

/** 显式栈、文档序（与 policy 主遍历同序：槽名键序 + 索引序）收集路径 → 节点摘要 */
function collect(root: IRNode, out: Map<string, NodeInfo>): void {
  const stack: Array<{ node: IRNode; path: string }> = [{ node: root, path: '<root>' }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    out.set(frame.path, { type: node.type, propsCanonical: canonicalize(node.props) });
    const names = Object.keys(node.slots);
    for (let n = names.length - 1; n >= 0; n--) {
      const children = node.slots[names[n]!]!;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i]!, path: `${frame.path}/slots.${names[n]!}[${i}]` });
      }
    }
  }
}

export function diffTrees(previous: IRNode | null, next: IRNode): ProposalDiff {
  const prevMap = new Map<string, NodeInfo>();
  if (previous !== null) collect(previous, prevMap);
  const nextMap = new Map<string, NodeInfo>();
  collect(next, nextMap);

  const added: string[] = [];
  const changed: string[] = [];
  let unchangedCount = 0;
  for (const [path, info] of nextMap) {
    const prev = prevMap.get(path);
    if (prev === undefined) {
      added.push(path);
    } else if (prev.type !== info.type || prev.propsCanonical !== info.propsCanonical) {
      changed.push(path);
    } else {
      unchangedCount += 1;
    }
  }
  const removed: string[] = [];
  for (const path of prevMap.keys()) {
    if (!nextMap.has(path)) removed.push(path);
  }
  return { added, removed, changed, unchangedCount };
}
