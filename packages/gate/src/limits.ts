import type { IRNode, JsonValue } from '@genui/ir';
import type { TraceEntry } from './types';

export interface Limits {
  maxDepth: number;
  maxNodes: number;
  maxChildrenPerNode: number;
  maxPropBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 32,
  maxNodes: 2000,
  maxChildrenPerNode: 64,
  maxPropBytes: 16384,
};

const PROP_SCAN_BUDGET = 100_000;

const encoder = new TextEncoder();

function propByteSize(value: JsonValue): number {
  let total = 0;
  let budget = PROP_SCAN_BUDGET;
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (budget-- <= 0) return Number.POSITIVE_INFINITY;
    if (typeof current === 'string') {
      total += encoder.encode(current).length;
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]!);
      }
      continue;
    }
    for (const key of Object.keys(current)) {
      stack.push(current[key]!);
    }
  }
  return total;
}

interface Frame {
  node: IRNode;
  path: string;
  depth: number;
}

export function checkLimits(root: IRNode, limits: Limits): TraceEntry[] {
  const violations: TraceEntry[] = [];
  let nodeCount = 0;
  let aborted = false;
  const stack: Frame[] = [{ node: root, path: '<root>', depth: 1 }];

  while (stack.length > 0 && !aborted) {
    const frame = stack.pop()!;
    const { node, path, depth } = frame;
    nodeCount += 1;

    if (nodeCount > limits.maxNodes) {
      violations.push({
        ruleId: 'limits.node-count',
        severity: 'critical',
        action: 'block',
        nodePath: path,
        message: `node count ${nodeCount} exceeds limit ${limits.maxNodes}`,
      });
      aborted = true;
      continue;
    }

    if (depth > limits.maxDepth) {
      violations.push({
        ruleId: 'limits.tree-depth',
        severity: 'critical',
        action: 'block',
        nodePath: path,
        message: `depth ${depth} exceeds limit ${limits.maxDepth}`,
      });
    }

    for (const [key, value] of Object.entries(node.props)) {
      const size = propByteSize(value);
      if (size > limits.maxPropBytes) {
        violations.push({
          ruleId: 'limits.prop-size',
          severity: 'critical',
          action: 'block',
          nodePath: `${path}.props.${key}`,
          message: `prop "${key}" is ${size === Number.POSITIVE_INFINITY ? 'over scan budget' : `${size} bytes`}, exceeds limit ${limits.maxPropBytes}`,
        });
      }
    }

    const slotNames = Object.keys(node.slots);
    let childCount = 0;
    for (const slotName of slotNames) {
      childCount += node.slots[slotName]?.length ?? 0;
    }
    if (childCount > limits.maxChildrenPerNode) {
      violations.push({
        ruleId: 'limits.children-count',
        severity: 'critical',
        action: 'block',
        nodePath: path,
        message: `node has ${childCount} children, exceeds limit ${limits.maxChildrenPerNode}`,
      });
    }

    for (let i = slotNames.length - 1; i >= 0; i--) {
      const slotName = slotNames[i]!;
      const children = node.slots[slotName]!;
      for (let j = children.length - 1; j >= 0; j--) {
        stack.push({
          node: children[j]!,
          path: `${path}/slots.${slotName}[${j}]`,
          depth: depth + 1,
        });
      }
    }
  }

  return violations;
}
