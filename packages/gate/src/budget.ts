import type { IRNode, JsonValue } from '@genui/ir';
import type { TraceEntry } from './types';

export interface Budgets {
  maxTextLength: number;
  maxListLength: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxTextLength: 10_000,
  maxListLength: 100,
};

const PROP_SCAN_BUDGET = 100_000;

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

interface PropFinding {
  key: string;
  path: string;
  kind: 'text' | 'list';
  size: number;
}

function scanProps(value: JsonValue, key: string, path: string, budget: { left: number }, findings: PropFinding[]): void {
  const stack: { value: JsonValue; key: string; path: string }[] = [{ value, key, path }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (budget.left-- <= 0) return;
    const item = current.value;
    if (typeof item === 'string') {
      findings.push({ key: current.key, path: current.path, kind: 'text', size: codePointLength(item) });
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      findings.push({ key: current.key, path: current.path, kind: 'list', size: item.length });
      for (let i = item.length - 1; i >= 0; i--) {
        stack.push({ value: item[i]!, key: current.key, path: `${current.path}[${i}]` });
      }
      continue;
    }
    const keys = Object.keys(item);
    for (let k = keys.length - 1; k >= 0; k--) {
      const subKey = keys[k]!;
      stack.push({ value: item[subKey] as JsonValue, key: current.key, path: `${current.path}.${subKey}` });
    }
  }
}

interface Frame {
  node: IRNode;
  path: string;
}

export function checkBudget(root: IRNode, budgets: Budgets): TraceEntry[] {
  const violations: TraceEntry[] = [];
  const stack: Frame[] = [{ node: root, path: '<root>' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, path } = frame;

    for (const [key, value] of Object.entries(node.props)) {
      const budget = { left: PROP_SCAN_BUDGET };
      const findings: PropFinding[] = [];
      scanProps(value, key, key, budget, findings);
      for (const finding of findings) {
        if (finding.kind === 'text' && finding.size > budgets.maxTextLength) {
          violations.push({
            ruleId: 'budget.text-length',
            severity: 'error',
            action: 'block',
            nodePath: `${path}.props.${finding.path}`,
            message: `text prop "${key}" has ${finding.size} code points, exceeds budget ${budgets.maxTextLength}`,
          });
        } else if (finding.kind === 'list' && finding.size > budgets.maxListLength) {
          violations.push({
            ruleId: 'budget.list-length',
            severity: 'error',
            action: 'block',
            nodePath: `${path}.props.${finding.path}`,
            message: `list prop "${key}" has ${finding.size} items, exceeds budget ${budgets.maxListLength}`,
          });
        }
      }
    }

    for (const slotName of Object.keys(node.slots)) {
      const children = node.slots[slotName]!;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i]!, path: `${path}/slots.${slotName}[${i}]` });
      }
    }
  }

  return violations;
}
