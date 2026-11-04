import type { IRNode } from '@genui/ir';
import type { Catalog } from './schema';
import type { TraceEntry } from './types';

interface Frame {
  node: IRNode;
  path: string;
}

export function checkWhitelist(root: IRNode, catalog: Catalog): TraceEntry[] {
  const violations: TraceEntry[] = [];
  const stack: Frame[] = [{ node: root, path: '<root>' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, path } = frame;
    if (!Object.hasOwn(catalog, node.type)) {
      violations.push({
        ruleId: 'whitelist.unknown-component',
        severity: 'critical',
        action: 'block',
        nodePath: path,
        message: `component type "${node.type}" is not in the catalog whitelist`,
      });
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
