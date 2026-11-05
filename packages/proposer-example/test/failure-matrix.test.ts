import { A2UISession } from '@genui/adapter-a2ui';
import type { A2UIMessage } from '@genui/adapter-a2ui';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IngestResult } from '@genui/session';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '../src';
import type { ClosedLoopState, ProposerGoal, ProposerRule } from '../src';

/**
 * 失败矩阵黄金测试（v2 §14，proposer-example 包）——每行一个黄金断言组，快照级进 CI。
 *
 * §14 行 → proposer-example 包落地映射（M1）：
 * - 「adapter 流损坏」行 → 四故障形态（TD-004/005 入口兜底 + applyFrame fail-closed）：
 *   - garbage（未知 kind）/ stray-surface（未知 surface）→ denied gate-error + adapter 回滚保基线；
 *   - invalid-frame（非 JSON）/ oversized-frame（超 256KB 预算）→ 入队即 dropped-*，不进帧边界流。
 *   本文件钉死：带已提交基线的黄金（现有 loop.test 拒绝路径为空 loop 口径）——
 *   故障后基线全等保留、帧全消费、故障不 fail-dead（好提案仍可用）。
 * - 「telemetry 上报失败」行 → 同 session 包重释（零出口），metrics 由 ClosedLoop 内部接线，此处由
 *   混沌测试顺带断言故障操作后 metrics.snapshot() 可用（聚合不崩溃）。
 * - 故障可观测性混沌（§15.5 最小注入）：故障 op 后立即可观测（denied 已置位或 ingest 已 dropped），
 *   帧全消费（queueFrames 0），零未捕获异常。
 */

const CREATE: ProposerGoal = {
  ruleId: 'create-restaurant-list',
  params: {
    restaurants: [{ name: 'The Italian Kitchen', cuisine: 'Italian', rating: '4.8' }],
  },
};
const CHIP: ProposerGoal = { ruleId: 'add-filter-chip', params: { label: 'Open now' } };

/** 故障注入规则（与 loop.test SPECIAL_RULES 同款）：garbage/stray 走 gate-error，invalid/oversized 走 dropped-* */
const SPECIAL_RULES: ProposerRule[] = [
  {
    id: 'garbage',
    description: 'emits a frame with an unknown message kind (gate-error path)',
    instantiate: (): A2UIMessage => ({ kind: 'nonsense', payload: {} }) as unknown as A2UIMessage,
  },
  {
    id: 'stray-surface',
    description: 'targets a foreign surface (gate-error path)',
    instantiate: (): A2UIMessage => ({
      kind: 'updateComponents',
      payload: { surfaceId: 'elsewhere', components: [{ id: 'root', component: 'Column' }] },
    }),
  },
  {
    id: 'invalid-frame',
    description: 'emits a non-JSON frame (dropped-invalid)',
    instantiate: (): A2UIMessage =>
      ({
        kind: 'createSurface',
        payload: {
          surfaceId: DEMO_SURFACE_ID,
          components: [{ id: 'root', component: 'Text', text: () => {} }],
        },
      }) as unknown as A2UIMessage,
  },
  {
    id: 'oversized-frame',
    description: 'emits a frame above the queue byte budget (dropped-oversized)',
    instantiate: (): A2UIMessage => ({
      kind: 'createSurface',
      payload: {
        surfaceId: 'big',
        components: [{ id: 'root', component: 'Text', text: 'x'.repeat(300 * 1024) }],
      },
    }),
  },
];

function matrixLoop(): ClosedLoop {
  return new ClosedLoop({
    rules: [...SPECIAL_RULES, ...createDemoRules(DEMO_SURFACE_ID)],
    surfaceId: DEMO_SURFACE_ID,
  });
}

/** adapter 一致性不变量（loop.test 同款）：adapter ≡ committed(+staged) 全量重放 */
function assertReplayInvariant(loop: ClosedLoop): void {
  const state = loop.state();
  const fresh = new A2UISession();
  for (const record of loop.getCommittedFrames()) {
    fresh.apply(record.message);
  }
  if (state.staged !== null) {
    const frame = loop.getStagedFrame();
    expect(frame).not.toBeNull();
    fresh.apply(frame!);
  } else {
    expect(loop.getStagedFrame()).toBeNull();
  }
  expect(loop.adapterSnapshot()).toEqual(fresh.snapshot());
}

interface FaultSpec {
  readonly goal: ProposerGoal;
  /** 期望 ingest 结果（queued = 进了帧边界流再被拒；dropped-* = 入队即丢） */
  readonly ingest: IngestResult['status'];
  /** 期望 state.denied（null = 不置 denied） */
  readonly deniedReason: 'gate-error' | null;
  /**
   * 基线模式：'with' = 先提交 CREATE 基线再注入（garbage/dropped-* 路径与基线无关）；
   * 'without' = 空_loop 注入——stray-surface 的 gate-error 依赖「应用后 surface 不可渲染」，
   * 有基线时 demo surface 存在，stray 帧成为无可见变化的合法提案（正常 stage，非故障）。
   */
  readonly baseline: 'with' | 'without';
}

const FAULTS: readonly FaultSpec[] = [
  { goal: { ruleId: 'garbage' }, ingest: 'queued', deniedReason: 'gate-error', baseline: 'with' },
  { goal: { ruleId: 'stray-surface' }, ingest: 'queued', deniedReason: 'gate-error', baseline: 'without' },
  { goal: { ruleId: 'invalid-frame' }, ingest: 'dropped-invalid', deniedReason: null, baseline: 'with' },
  { goal: { ruleId: 'oversized-frame' }, ingest: 'dropped-oversized', deniedReason: null, baseline: 'with' },
];

describe('adapter 行：流损坏四故障 → fail-closed + 基线保留（§14）', () => {
  for (const fault of FAULTS) {
    it(`黄金快照：${fault.baseline === 'with' ? '有已提交基线' : '空_loop'}时 ${fault.goal.ruleId} → ${fault.deniedReason ?? fault.ingest}，fail-closed 不 fail-dead`, () => {
      const loop = matrixLoop();
      let baseline: ReturnType<ClosedLoop['adapterSnapshot']> | null = null;
      if (fault.baseline === 'with') {
        loop.propose(CREATE);
        expect(loop.confirm().status).toBe('committed');
        baseline = loop.adapterSnapshot();
        expect(loop.getCommittedFrames()).toHaveLength(1);
      }

      const state = loop.propose(fault.goal);
      // 入队结果精确
      expect(loop.getLastIngestResult()!.status).toBe(fault.ingest);
      // denied 精确（dropped-* 不置 denied；gate-error 精确对象）
      if (fault.deniedReason === null) {
        expect(state.denied).toBeNull();
      } else if (fault.baseline === 'without') {
        expect(state.denied).toEqual({
          reason: 'gate-error',
          message: `frame evaluation failed: surface "${DEMO_SURFACE_ID}" is not renderable after applying frame`,
        });
      } else {
        expect(state.denied?.reason).toBe('gate-error');
      }
      // 帧全消费
      expect(state.queueFrames).toBe(0);
      if (baseline !== null) {
        // 基线全等保留：adapter 状态与故障前逐字段一致
        expect(loop.adapterSnapshot()).toEqual(baseline);
        // metrics 聚合可用（telemetry 行：故障不击穿本地指标）
        expect(loop.metrics.snapshot().global.counts.committed).toBe(1);
      }

      // fail-closed 不 fail-dead：故障后好提案仍走完整生命周期
      const after = loop.propose(fault.baseline === 'with' ? CHIP : CREATE);
      expect(after.denied).toBeNull();
      expect(after.staged).not.toBeNull();
      expect(loop.confirm().status).toBe('committed');
      assertReplayInvariant(loop);
    });
  }
});

describe('故障可观测性混沌（§15.5 最小注入）', () => {
  it('性质 ×100：故障 op 后立即可观测 + 帧全消费 + 零未捕获 + 重放不变量保持', () => {
    const faultGoalArb = fc.constantFrom(...FAULTS.map((fault) => fault.goal));
    const opArb = fc.oneof(
      faultGoalArb.map((goal) => ({ kind: 'fault' as const, goal })),
      fc.constantFrom(CREATE, CHIP).map((goal) => ({ kind: 'propose' as const, goal })),
      fc.constant({ kind: 'confirm' as const }),
      fc.constant({ kind: 'discard' as const }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 24 }), (ops) => {
        const loop = matrixLoop();
        const faultSpecOf = (ruleId: string): FaultSpec => {
          const spec = FAULTS.find((fault) => fault.goal.ruleId === ruleId);
          expect(spec).toBeDefined();
          return spec!;
        };
        for (const op of ops) {
          let state: ClosedLoopState;
          if (op.kind === 'fault') {
            const spec = faultSpecOf(op.goal.ruleId);
            // stray-surface 的结局依赖基线：有已提交 surface → 正常 stage（stray 帧无可见变化）；
            // 无基线 → surface 不可渲染 → denied gate-error。两者均立即可观测。
            const hasBaseline = loop.getCommittedFrames().length > 0;
            state = loop.propose(op.goal);
            expect(loop.getLastIngestResult()!.status).toBe(spec.ingest);
            if (spec.deniedReason !== null) {
              if (op.goal.ruleId === 'stray-surface') {
                if (hasBaseline) {
                  expect(state.staged).not.toBeNull();
                } else {
                  expect(state.denied?.reason).toBe('gate-error');
                }
              } else {
                expect(state.denied?.reason).toBe(spec.deniedReason);
              }
            }
          } else if (op.kind === 'propose') {
            state = loop.propose(op.goal);
          } else if (op.kind === 'confirm') {
            loop.confirm();
            state = loop.state();
          } else {
            loop.discard();
            state = loop.state();
          }
          // 帧全消费：任意 op 后队列清空
          expect(state.queueFrames).toBe(0);
        }
        // 终态一致性 + metrics 可用
        assertReplayInvariant(loop);
        expect(loop.metrics.snapshot().global.counts).toBeDefined();
      }),
      { numRuns: 100 },
    );
  }, 30_000);

  it('确定性：同一故障交错序列双执行恒得同一终态', () => {
    const script = (): string => {
      const loop = matrixLoop();
      loop.propose(CREATE);
      loop.confirm();
      loop.propose({ ruleId: 'garbage' });
      loop.propose(CHIP);
      loop.confirm();
      loop.propose({ ruleId: 'invalid-frame' });
      loop.propose({ ruleId: 'stray-surface' });
      loop.propose({ ruleId: 'oversized-frame' });
      loop.propose(CHIP);
      loop.confirm();
      loop.revert(1);
      return JSON.stringify({
        state: loop.state(),
        adapter: loop.adapterSnapshot(),
        metrics: loop.metrics.snapshot(),
        frames: loop.getCommittedFrames(),
      });
    };
    expect(script()).toBe(script());
  });
});
