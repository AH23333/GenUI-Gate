import type { IRNode } from '@genui/ir';
import type { CheckRegistry, TreeContext } from './types';

/**
 * 内置检查谓词注册表（v2 §7.2：check/fixer 是内置具名谓词，策略文档不可携带代码）。
 * - `always`：纯 match 规则（命中 match 即触发）。
 * - `heading-order`：markdown 标题跳级（组合级，读 TreeContext.headingPrev）。
 * - `has-landmark`：全树无 landmark（组合级，只在根节点触发，读 TreeContext.landmarks）。
 * - `interactive-focusable`：交互元素（props.action）声明 accessibility.focusable=false。
 * 语义均为 [假设，P0 校准点]：baseline 预设对 WCAG 实践的静态子集，随社区语料校准。
 */

/** ARIA landmark roles（小写；role 值比较前统一 toLowerCase，宽容但确定） */
export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
]);

/**
 * markdown ATX 标题层级：`#{1,6}` + 空白 起始（CommonMark：`#` 后须有空白，7 个 # 非标题）。
 * 返回 null = 非标题文本。组件不限（协议无关：任何节点 props.text 为标题形态即计入文档序）。
 */
export function parseHeadingLevel(text: string): number | null {
  const match = /^(#{1,6})\s/.exec(text);
  if (match === null) return null;
  return match[1]!.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** landmark 判定：props.accessibility 是对象且 role 字符串 ∈ LANDMARK_ROLES（大小写宽容） */
export function isLandmarkNode(node: IRNode): boolean {
  const meta = node.props['accessibility'];
  if (!isPlainObject(meta)) return false;
  const role = meta['role'];
  if (typeof role !== 'string') return false;
  return LANDMARK_ROLES.has(role.toLowerCase());
}

/** 交互元素判定：props 带 `action`（A2UI 交互绑定，envelope 语义留在 props，KAN-011） */
export function isInteractiveNode(node: IRNode): boolean {
  return Object.hasOwn(node.props, 'action');
}

export const BUILTIN_CHECKS: CheckRegistry = {
  always: () => true,
  'heading-order': (node: IRNode, path: string, ctx: TreeContext): boolean => {
    const text = node.props['text'];
    if (typeof text !== 'string') return false;
    const level = parseHeadingLevel(text);
    if (level === null) return false;
    const previous = ctx.headingPrev.get(path);
    if (previous === undefined) return false;
    return previous !== null && level > previous + 1;
  },
  'has-landmark': (node: IRNode, path: string, ctx: TreeContext): boolean => {
    return path === '<root>' && ctx.landmarks === 0;
  },
  'interactive-focusable': (node: IRNode): boolean => {
    if (!isInteractiveNode(node)) return false;
    const meta = node.props['accessibility'];
    return isPlainObject(meta) && meta['focusable'] === false;
  },
};
