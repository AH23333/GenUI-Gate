import { PendingFrameQueue } from '../packages/session/src/index';

/**
 * Session 帧摄入预算检查（v2 §6.6，[假设，P0 校准点]）：
 * PendingFrameQueue.ingest() p99 必须 <= 10 ms。
 *
 * 三个场景：
 * 1. small frame (~100B canonical) —— 常规路径；
 * 2. max-size frame (256KB, 单帧预算边界) —— isJsonValue + canonicalize
 *    + UTF-8 编码的最坏情况；
 * 3. overflow path —— 队列满帧时入队（丢最旧 + resync 标志）。
 *
 * 确定性：固定帧形状，被测代码路径无随机、无时钟。计时区间只包 ingest；
 * 场景 1/2 在计时区外用 takeOldest 排空以防真实溢出污染测量。
 * 运行：`pnpm bench:session`。退出码：0 = 预算内，2 = 超预算。
 */

const BUDGET_MS = 10;
const WARMUP = 100;
const ITERATIONS = 1000;

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

interface Scenario {
  name: string;
  setup: () => PendingFrameQueue;
  frame: () => unknown;
  /** 计时区外的收尾（如排空），不计入测量 */
  after?: (queue: PendingFrameQueue) => void;
}

function benchmark(scenario: Scenario): { p50: number; p95: number; p99: number } {
  const queue = scenario.setup();
  const frame = scenario.frame();
  for (let i = 0; i < WARMUP; i++) {
    queue.ingest(frame);
    scenario.after?.(queue);
  }
  const durations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    queue.ingest(frame);
    durations.push(performance.now() - start);
    scenario.after?.(queue);
  }
  durations.sort((a, b) => a - b);
  return {
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
  };
}

function main(): number {
  const scenarios: Scenario[] = [
    {
      name: 'small frame (~100B canonical), drain outside timing',
      setup: () => new PendingFrameQueue(),
      frame: () => ({ op: 'updateComponents', seq: 42, payload: { text: 'x'.repeat(64) } }),
      after: (queue) => queue.takeOldest(),
    },
    {
      name: 'max-size frame (256KB, single-frame budget boundary)',
      setup: () => new PendingFrameQueue(),
      frame: () => ({ a: 'x'.repeat(262136) }),
      after: (queue) => queue.takeOldest(),
    },
    {
      name: 'overflow path (queue full, drop-oldest + resync)',
      setup: () => new PendingFrameQueue({ maxQueueFrames: 1 }),
      frame: () => ({ op: 'updateComponents', seq: 42, payload: { text: 'y'.repeat(48) } }),
    },
  ];

  const lines = [
    'GenUI session bench: PendingFrameQueue.ingest() (v2 §6.6 budget check)',
    `Iterations: ${ITERATIONS} (warmup ${WARMUP})`,
  ];

  let pass = true;
  for (const scenario of scenarios) {
    const { p50, p95, p99 } = benchmark(scenario);
    const ok = p99 <= BUDGET_MS;
    pass = pass && ok;
    lines.push(
      `Scenario: ${scenario.name}`,
      `  p50: ${p50.toFixed(3)} ms`,
      `  p95: ${p95.toFixed(3)} ms`,
      `  p99: ${p99.toFixed(3)} ms`,
      `  VERDICT: ${ok ? 'PASS' : 'FAIL'} (budget p99 <= ${BUDGET_MS} ms, v2 §6.6, [假设，P0 校准点])`,
    );
  }

  lines.push(`OVERALL: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(lines.join('\n'));

  return pass ? 0 : 2;
}

process.exit(main());
