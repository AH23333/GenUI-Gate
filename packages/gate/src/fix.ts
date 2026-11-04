import type { IRNode, JsonValue } from '@genui/ir';
import type { Severity, TraceEntry } from './types';

/** 单帧 fix 链应用次数上限（v2 §6.6），超次降级 block */
export const MAX_FIX_CHAIN = 50;
/** fix 路径段数上限：applyFixes 独立使用时的递归深度护栏（与 limits.maxDepth 对齐） */
export const MAX_FIX_PATH_DEPTH = 32;

/**
 * 具名修复器（v2 §6.4）：纯函数，输入目标节点，输出修复后节点 + before/after 快照。
 * 完备性契约：修复后触发该规则的判定不得再次命中；无法修复时返回 null（fail-closed 升级 block）。
 */
export type Fixer = (node: IRNode) => FixerResult | null;

export interface FixerResult {
  node: IRNode;
  before: JsonValue;
  after: JsonValue;
}

export interface FixRequest {
  ruleId: string;
  severity: Severity;
  nodePath: string;
  fixer: string;
  message: string;
}

export interface FixResult {
  ir: IRNode;
  trace: TraceEntry[];
  applied: number;
}

interface PathSegment {
  slot: string;
  index: number;
}

interface Applied {
  node: IRNode;
  before: JsonValue;
  after: JsonValue;
}

/**
 * 解析 trace nodePath（`<root>/slots.a[0]/slots.b[2]` 形态）。
 * 返回 null 表示不可解析（宿主 slot 名含 `[`/`]`/`/` 等病态字符，或格式非法）。
 */
export function parseNodePath(path: string): PathSegment[] | null {
  const ROOT = '<root>';
  if (path === ROOT) return [];
  if (!path.startsWith(`${ROOT}/slots.`)) return null;
  const segments: PathSegment[] = [];
  let rest = path.slice(ROOT.length);
  while (rest.length > 0) {
    const match = /^\/slots\.([^\[\]/]+)\[(\d+)\]/.exec(rest);
    if (match === null) return null;
    segments.push({ slot: match[1]!, index: Number(match[2]) });
    rest = rest.slice(match[0].length);
  }
  return segments;
}

function applyAtPath(node: IRNode, segments: PathSegment[], fixer: Fixer): Applied | null {
  if (segments.length === 0) {
    const result = fixer(node);
    if (result === null) return null;
    return { node: result.node, before: result.before, after: result.after };
  }
  const seg = segments[0]!;
  const children = node.slots[seg.slot];
  if (children === undefined || seg.index >= children.length) return null;
  const child = children[seg.index]!;
  const applied = applyAtPath(child, segments.slice(1), fixer);
  if (applied === null) return null;
  const newChildren = children.slice();
  newChildren[seg.index] = applied.node;
  const slots: Record<string, IRNode[]> = { ...node.slots };
  slots[seg.slot] = newChildren;
  return { node: { ...node, slots }, before: applied.before, after: applied.after };
}

function degrade(request: FixRequest, reason: string): TraceEntry {
  return {
    ruleId: request.ruleId,
    severity: 'error',
    action: 'block',
    nodePath: request.nodePath,
    message: `${request.message}; ${reason}`,
  };
}

/**
 * 应用 fix 链（v2 §6.1 fix 阶段 / §6.4 / §6.6）。
 * 逐请求串行应用；任何失败（未知修复器、路径失效、修复器拒绝、路径过深、链超限）
 * 一律 fail-closed 降级为 error+block，绝不静默跳过。
 * 返回的 ir 与输入不共享可变结构（路径上结构重建，其余共享）。
 */
export function applyFixes(
  root: IRNode,
  requests: readonly FixRequest[],
  fixers: Readonly<Record<string, Fixer>>,
): FixResult {
  const trace: TraceEntry[] = [];
  let ir = root;
  let applied = 0;

  for (const request of requests) {
    if (applied >= MAX_FIX_CHAIN) {
      trace.push(degrade(request, `fix chain exceeded ${MAX_FIX_CHAIN} applications`));
      continue;
    }
    const fixer = fixers[request.fixer];
    if (fixer === undefined) {
      trace.push(degrade(request, `unknown fixer "${request.fixer}"`));
      continue;
    }
    const segments = parseNodePath(request.nodePath);
    if (segments === null || segments.length > MAX_FIX_PATH_DEPTH) {
      trace.push(degrade(request, `unusable fix path "${request.nodePath}"`));
      continue;
    }
    const result = applyAtPath(ir, segments, fixer);
    if (result === null) {
      trace.push(degrade(request, `fixer "${request.fixer}" not applicable`));
      continue;
    }
    ir = result.node;
    applied += 1;
    trace.push({
      ruleId: request.ruleId,
      severity: request.severity,
      action: 'transform',
      nodePath: request.nodePath,
      message: request.message,
      before: result.before,
      after: result.after,
    });
  }

  return { ir, trace, applied };
}
