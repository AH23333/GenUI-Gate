import { gate } from '@genui/gate';
import type { IRNode } from '@genui/ir';

/**
 * A6 budget check (v2 §6.6, all values [assumption, P0 calibration point]):
 * gate() full pipeline p99 @ 500 nodes / depth 12 must be <= 5 ms.
 *
 * Deterministic by construction: fixed tree shape, no randomness, no clock in
 * the measured code path. Run: `pnpm bench`. Exit codes: 0 = within budget,
 * 2 = over budget.
 */

const NODE_TARGET = 500;
const DEPTH_TARGET = 12;
const BUDGET_MS = 5;
const WARMUP = 100;
const ITERATIONS = 2000;

function makeNode(id: number): IRNode {
  return {
    id: `n${id}`,
    type: 'Card',
    props: {
      title: `node ${id} title text for prop scan`,
      index: id,
      pinned: id % 2 === 0,
    },
    slots: {},
  };
}

/**
 * Wide tree: level 0 is the root, the remaining nodes are spread evenly over
 * DEPTH_TARGET - 1 levels; each level-k node attaches to a level-(k-1) node
 * round-robin. Exact node count and exact max depth, fully deterministic.
 */
function buildTree(nodeTarget: number, depthTarget: number): IRNode {
  if (nodeTarget < 1 || depthTarget < 1) {
    throw new Error('nodeTarget and depthTarget must be >= 1');
  }
  const nodes: IRNode[] = [makeNode(0)];
  const parentOf: number[] = [-1];

  const innerLevels = depthTarget - 1;
  const rest = nodeTarget - 1;
  if (innerLevels > 0 && rest > 0) {
    const perLevel = Math.floor(rest / innerLevels);
    const remainder = rest % innerLevels;
    let prevStart = 0;
    let prevCount = 1;
    let levelStart = 1;
    let nextId = 1;
    for (let level = 1; level < depthTarget; level++) {
      const count = perLevel + (level <= remainder ? 1 : 0);
      for (let j = 0; j < count; j++) {
        parentOf.push(prevStart + (j % prevCount));
        nodes.push(makeNode(nextId));
        nextId += 1;
      }
      prevStart = levelStart;
      prevCount = count;
      levelStart = nextId;
    }
  }

  for (let i = 1; i < nodes.length; i++) {
    const parent = nodes[parentOf[i]!]!;
    const slot = parent.slots['children'] ?? (parent.slots['children'] = []);
    slot.push(nodes[i]!);
  }
  return nodes[0]!;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function measureDepth(root: IRNode): number {
  let maxDepth = 0;
  const stack: Array<{ node: IRNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > maxDepth) maxDepth = frame.depth;
    for (const name of Object.keys(frame.node.slots)) {
      for (const child of frame.node.slots[name]!) {
        stack.push({ node: child, depth: frame.depth + 1 });
      }
    }
  }
  return maxDepth;
}

function countNodes(root: IRNode): number {
  let count = 0;
  const stack: IRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    for (const name of Object.keys(node.slots)) {
      for (const child of node.slots[name]!) {
        stack.push(child);
      }
    }
  }
  return count;
}

function main(): number {
  const root = buildTree(NODE_TARGET, DEPTH_TARGET);
  const nodeCount = countNodes(root);
  const depth = measureDepth(root);

  for (let i = 0; i < WARMUP; i++) gate(root);

  const durations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    gate(root);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);

  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);
  const pass = p99 <= BUDGET_MS;

  const lines = [
    'GenUI Gate bench: gate() pipeline (A6 budget check)',
    `Tree: ${nodeCount} nodes, depth ${depth}`,
    `Iterations: ${ITERATIONS} (warmup ${WARMUP})`,
    `p50: ${p50.toFixed(3)} ms`,
    `p95: ${p95.toFixed(3)} ms`,
    `p99: ${p99.toFixed(3)} ms`,
    `Budget: p99 <= ${BUDGET_MS} ms (v2 section 6.6, [assumption, P0 calibration point])`,
    `VERDICT: ${pass ? 'PASS' : 'FAIL'} (p99 ${p99.toFixed(3)} ms ${pass ? '<=' : '>'} ${BUDGET_MS} ms)`,
  ];
  console.log(lines.join('\n'));

  return pass ? 0 : 2;
}

process.exit(main());
