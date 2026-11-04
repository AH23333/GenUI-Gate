import type { FixRequest, TraceEntry } from '@genui/gate';
import type { IRNode } from '@genui/ir';
import { isLandmarkNode, parseHeadingLevel } from './checks';
import type { CompiledPolicy, CompiledRule, PolicyEvaluation, TreeContext } from './types';

function matchesRule(rule: CompiledRule, node: IRNode): boolean {
  for (const prop of rule.presentProps) {
    if (!Object.hasOwn(node.props, prop)) return false;
  }
  for (const prop of rule.absentProps) {
    if (Object.hasOwn(node.props, prop)) return false;
  }
  return true;
}

/**
 * 组合级检查的树级上下文预计算（1.5）：
 * 单遍文档序遍历（显式栈、slots 键序 + 子索引序，与主遍历同序），
 * 收集 landmark 总数与标题跳级序列。纯读，不改 IR。
 */
export function computeTreeContext(root: IRNode): TreeContext {
  const headingPrev = new Map<string, number | null>();
  let landmarks = 0;
  let lastHeadingLevel: number | null = null;
  const stack: { node: IRNode; path: string }[] = [{ node: root, path: '<root>' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    const path = frame.path;

    if (isLandmarkNode(node)) landmarks += 1;
    const text = node.props['text'];
    if (typeof text === 'string') {
      const level = parseHeadingLevel(text);
      if (level !== null) {
        headingPrev.set(path, lastHeadingLevel);
        lastHeadingLevel = level;
      }
    }

    const slotNames = Object.keys(node.slots);
    for (let i = slotNames.length - 1; i >= 0; i--) {
      const slotName = slotNames[i]!;
      const children = node.slots[slotName]!;
      for (let j = children.length - 1; j >= 0; j--) {
        stack.push({ node: children[j]!, path: `${path}/slots.${slotName}[${j}]` });
      }
    }
  }

  return { landmarks, headingPrev };
}

function mergeCandidates(componentBucket: number[] | undefined, globalBucket: number[] | undefined): number[] {
  const candidates: number[] = [];
  let i = 0;
  let j = 0;
  while (i < (componentBucket?.length ?? 0) && j < (globalBucket?.length ?? 0)) {
    const a = componentBucket![i]!;
    const b = globalBucket![j]!;
    if (a < b) {
      candidates.push(a);
      i++;
    } else if (a > b) {
      candidates.push(b);
      j++;
    } else {
      candidates.push(a);
      i++;
      j++;
    }
  }
  while (i < (componentBucket?.length ?? 0)) {
    candidates.push(componentBucket![i]!);
    i++;
  }
  while (j < (globalBucket?.length ?? 0)) {
    candidates.push(globalBucket![j]!);
    j++;
  }
  return candidates;
}

/**
 * 求值编译后的策略（v2 §7.2/§7.3）：
 * - 显式栈遍历（与 gate 全仓树遍历纪律一致），确定性输出顺序；
 * - off 规则跳过；enforce 规则发 trace 条目（transform 规则另发 fix 请求）；
 * - shadow 规则只发 action='pass' + shadowAction=<本应触发的 action> 的记录条目，
 *   不参与聚合、不产生 fix 请求（v2 §7.3）。
 */
export function evaluatePolicy(compiled: CompiledPolicy, root: IRNode): PolicyEvaluation {
  const entries: TraceEntry[] = [];
  const fixRequests: FixRequest[] = [];
  const ctx = computeTreeContext(root);
  const stack: { node: IRNode; path: string }[] = [{ node: root, path: '<root>' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    const path = frame.path;

    const candidates = mergeCandidates(compiled.buckets.get(node.type), compiled.buckets.get(null));
    for (const index of candidates) {
      const rule = compiled.rules[index]!;
      if (rule.mode === 'off') continue;
      if (!matchesRule(rule, node)) continue;
      if (!rule.checkFn(node, path, ctx)) continue;

      if (rule.mode === 'shadow') {
        entries.push({
          ruleId: rule.id,
          severity: rule.severity,
          action: 'pass',
          shadowAction: rule.action,
          nodePath: path,
          message: `[shadow] ${rule.message}`,
        });
        continue;
      }

      entries.push({
        ruleId: rule.id,
        severity: rule.severity,
        action: rule.action,
        nodePath: path,
        message: rule.message,
      });
      if (rule.action === 'transform' && rule.fixer !== null) {
        fixRequests.push({
          ruleId: rule.id,
          severity: rule.severity,
          nodePath: path,
          fixer: rule.fixer,
          message: rule.message,
        });
      }
    }

    const slotNames = Object.keys(node.slots);
    for (let i = slotNames.length - 1; i >= 0; i--) {
      const slotName = slotNames[i]!;
      const children = node.slots[slotName]!;
      for (let j = children.length - 1; j >= 0; j--) {
        stack.push({ node: children[j]!, path: `${path}/slots.${slotName}[${j}]` });
      }
    }
  }

  return { entries, fixRequests };
}
