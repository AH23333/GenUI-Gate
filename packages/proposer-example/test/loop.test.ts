import { A2UISession } from '@genui/adapter-a2ui';
import type { A2UIMessage } from '@genui/adapter-a2ui';
import type { IRNode } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { InteractionCounts, ZoneReport } from '@genui/session';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '../src';
import type { ClosedLoopOptions, ClosedLoopState, ProposerGoal, ProposerRule } from '../src';

const RESTAURANTS = [
  { name: 'The Italian Kitchen', cuisine: 'Italian', rating: '4.8' },
  { name: 'Golden Dragon', cuisine: 'Chinese', rating: '4.5' },
  { name: 'Blue Ocean Sushi', cuisine: 'Japanese', rating: '4.6' },
];

const CREATE: ProposerGoal = { ruleId: 'create-restaurant-list', params: { restaurants: RESTAURANTS } };
const CHIP: ProposerGoal = { ruleId: 'add-filter-chip', params: { label: 'Open now' } };
const DETAILS: ProposerGoal = {
  ruleId: 'show-restaurant-details',
  params: { name: 'Pasta Bar', rating: '4.7', distance: '0.4 mi', deliveryTime: '15-25 min' },
};
const SORT: ProposerGoal = { ruleId: 'set-sort-order', params: { field: 'rating' } };
const BLOCKED: ProposerGoal = { ruleId: 'blocked-deep-chain' };

/** 故障注入规则（性质测试/拒绝路径装置）：garbage 走 gate-error，stray 走 gate-error，
 *  invalid 走 dropped-invalid，oversized 走 dropped-oversized（TD-004/005 入口兜底） */
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

function createLoop(options?: Partial<ClosedLoopOptions>): ClosedLoop {
  return new ClosedLoop({
    rules: createDemoRules(DEMO_SURFACE_ID),
    surfaceId: DEMO_SURFACE_ID,
    ...options,
  });
}

function surfaceOf(loop: ClosedLoop) {
  const surface = loop
    .adapterSnapshot()
    .surfaces.find((entry) => entry.surfaceId === DEMO_SURFACE_ID);
  expect(surface).toBeDefined();
  return surface!;
}

function findById(root: IRNode, id: string): IRNode | null {
  if (root.id === id) return root;
  for (const children of Object.values(root.slots)) {
    for (const child of children) {
      const found = findById(child, id);
      if (found !== null) return found;
    }
  }
  return null;
}

function zoneReport(loop: ClosedLoop): ZoneReport {
  const zone = loop.metrics.snapshot().zones.find((entry) => entry.zone === 'main');
  expect(zone).toBeDefined();
  return zone!;
}

function zoneCounts(loop: ClosedLoop): InteractionCounts {
  return zoneReport(loop).counts;
}

/** adapter 一致性不变量：任意操作后 adapter ≡ committed(+staged) 全量重放 */
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

describe('ClosedLoop 构造校验（fail-loud）', () => {
  it('surfaceId 空/非字符串抛 RangeError', () => {
    expect(() => new ClosedLoop({ rules: [], surfaceId: '' })).toThrow(RangeError);
    expect(() => new ClosedLoop({ rules: [], surfaceId: 7 as unknown as string })).toThrow(RangeError);
  });

  it('zone 空/非字符串抛 RangeError', () => {
    expect(() => new ClosedLoop({ rules: [], surfaceId: 'x', zone: '' })).toThrow(RangeError);
  });

  it('rules 非数组抛 TypeError', () => {
    expect(() => new ClosedLoop({ rules: 'nope' as unknown as readonly ProposerRule[], surfaceId: 'x' })).toThrow(TypeError);
  });
});

describe('闭环主流程（propose → gate → preview → confirm）', () => {
  it('全链路：create → chip → details 三次确认，树逐级生长', () => {
    const loop = createLoop();
    expect(loop.getRuleIds()[0]).toBe('create-restaurant-list');
    expect(loop.getLastIngestResult()).toBeNull();

    let state: ClosedLoopState = loop.propose(CREATE);
    expect(state.staged).not.toBeNull();
    expect(state.applied).toBeNull();
    expect(state.denied).toBeNull();
    expect(state.locked).toBe(false);
    expect(state.queueFrames).toBe(0); // 同步帧边界流：处理完即清空
    expect(state.resyncRequired).toBe(false);
    const createStaged = state.staged!;
    expect(createStaged.verdict).toBe('pass');
    expect(createStaged.diff.added.length).toBeGreaterThan(0);
    expect(createStaged.diff.removed).toHaveLength(0);
    expect(createStaged.diff.unchangedCount).toBe(0); // 基线为 null：全树 added

    // 预览与 commit 消费同一 IR′ 引用（v2 §9.1 判定标准）
    const committed = loop.confirm();
    expect(committed.status).toBe('committed');
    expect(committed.proposal!.irPrime).toBe(createStaged.irPrime);

    state = loop.state();
    expect(state.applied!.id).toBe(createStaged.id);
    expect(state.staged).toBeNull();
    expect(loop.getCommittedFrames()).toHaveLength(1);
    expect(loop.getStagedFrame()).toBeNull();

    state = loop.propose(CHIP);
    expect(state.staged).not.toBeNull();
    // 位置键控 diff：chip 插入引起兄弟索引整体漂移（added+removed+changed 并存）
    expect(state.staged!.diff.added.length).toBeGreaterThan(0);
    expect(state.staged!.diff.removed.length).toBeGreaterThan(0);
    loop.confirm();

    state = loop.propose(DETAILS);
    expect(state.staged).not.toBeNull();
    loop.confirm();

    const surface = surfaceOf(loop);
    expect(findById(surface.ir!, 'filter_chip')).not.toBeNull();
    expect(findById(surface.ir!, 'details_card')).not.toBeNull();
    expect(findById(surface.ir!, 'footer')!.slots['children']!).toHaveLength(1);
    expect(loop.getCommittedFrames().map((record) => record.committedSeq)).toEqual([2, 4, 6]);
    assertReplayInvariant(loop);
  });

  it('confirm/discard 无 staged 时为幂等 no-op（不抛错）', () => {
    const loop = createLoop();
    expect(loop.confirm().status).toBe('no-staged');
    expect(loop.discard().status).toBe('no-staged');
    expect(loop.revert().status).toBe('no-snapshot');
  });

  it('discard：staged 中止 + adapter 回滚到 applied 基线', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm();
    const baselineSnapshot = loop.adapterSnapshot();

    loop.propose(CHIP);
    expect(loop.state().staged).not.toBeNull();
    expect(findById(surfaceOf(loop).ir!, 'filter_chip')).not.toBeNull(); // 预览可见

    const result = loop.discard();
    expect(result.status).toBe('aborted');
    const state = loop.state();
    expect(state.staged).toBeNull();
    expect(loop.getStagedFrame()).toBeNull();
    expect(loop.adapterSnapshot()).toEqual(baselineSnapshot);
    expect(findById(surfaceOf(loop).ir!, 'filter_chip')).toBeNull();
    expect(zoneCounts(loop).ignore).toBe(1);
  });
});

describe('回滚（revert）', () => {
  it('session 与 adapter 同步回滚；dataModel.sortOrder 一并恢复（resync 纪律测量点）', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm();
    loop.propose(CHIP);
    loop.confirm();

    loop.propose(SORT);
    // 结构不变提案：diff 全 unchanged（dataModel 不进 IR 树）
    const sortStaged = loop.state().staged!;
    expect(sortStaged.diff.added).toHaveLength(0);
    expect(sortStaged.diff.removed).toHaveLength(0);
    expect(sortStaged.diff.changed).toHaveLength(0);
    expect(sortStaged.diff.unchangedCount).toBeGreaterThan(0);
    loop.confirm();

    let surface = surfaceOf(loop);
    expect(surface.dataModel['sortOrder']).toBe('rating');
    expect(findById(surface.ir!, 'filter_chip')).not.toBeNull();

    const result = loop.revert(1);
    expect(result.status).toBe('reverted');
    expect(result.snapshot!.id).toBe(loop.state().applied!.id);

    surface = surfaceOf(loop);
    expect(surface.dataModel['sortOrder']).toBeUndefined(); // 回滚只能经 adapter 重放
    expect(findById(surface.ir!, 'filter_chip')).not.toBeNull(); // chip 是第 2 次提交，保留
    expect(findById(surface.ir!, 'details_card')).toBeNull();
    expect(loop.getCommittedFrames().map((record) => record.committedSeq)).toEqual([2, 4]);

    // 再回滚两步越界 → no-snapshot；一步回到 create
    expect(loop.revert(2).status).toBe('no-snapshot');
    expect(loop.revert(1).status).toBe('reverted');
    surface = surfaceOf(loop);
    expect(surface.dataModel['restaurants']).toBeDefined();
    expect(findById(surface.ir!, 'filter_chip')).toBeNull();
    expect(zoneCounts(loop).rollback).toBe(2);
    assertReplayInvariant(loop);
  });

  it('ringSize 3：第 4 次提交逐出最旧快照；帧日志保留全链（重放源不因逐出而剪）', () => {
    const loop = createLoop({ ringSize: 3 });
    loop.propose(CREATE);
    loop.confirm();
    loop.propose(CHIP);
    loop.confirm();
    loop.propose(DETAILS);
    loop.confirm();
    loop.propose(SORT);
    loop.confirm();
    expect(loop.getCommittedFrames()).toHaveLength(4); // createSurface 帧仍在日志

    expect(loop.revert(3).status).toBe('no-snapshot'); // 深度只剩 2
    expect(loop.revert(2).status).toBe('reverted'); // 回到 chip
    const surface = surfaceOf(loop);
    expect(findById(surface.ir!, 'filter_chip')).not.toBeNull();
    expect(findById(surface.ir!, 'details_card')).toBeNull();
    expect(loop.getCommittedFrames().map((record) => record.committedSeq)).toEqual([2, 4]);
    assertReplayInvariant(loop);
  });
});

describe('拒绝路径（fail-closed：denied + adapter 回滚）', () => {
  it('gate 拦截（blocked-deep-chain，33 > maxDepth 32）→ denied(blocked)', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm();
    const before = loop.adapterSnapshot();

    const state = loop.propose(BLOCKED);
    expect(state.denied).toEqual({ reason: 'blocked', message: 'proposal blocked by gate' });
    expect(state.staged).toBeNull();
    expect(loop.adapterSnapshot()).toEqual(before);
    expect(loop.getLastIngestResult()!.status).toBe('queued');
    const counts = zoneCounts(loop);
    expect(counts.deniedBlocked).toBe(1);
    expect(counts.proposals).toBe(1); // stage 被拒不进 proposals 口径
  });

  it('帧结构非法（未知 kind）→ denied(gate-error)，不触碰 adapter', () => {
    const loop = createLoop({ rules: [SPECIAL_RULES[0]!, ...createDemoRules(DEMO_SURFACE_ID)] });
    const state = loop.propose({ ruleId: 'garbage' });
    expect(state.denied).toEqual({
      reason: 'gate-error',
      message: 'frame is not a valid A2UI message',
    });
    expect(loop.adapterSnapshot().surfaces).toHaveLength(0);
    expect(loop.metrics.snapshot().global.counts.proposals).toBe(0);
  });

  it('规则帧指向未知 surface → denied(gate-error) + 回滚', () => {
    const loop = createLoop({ rules: [SPECIAL_RULES[1]!, ...createDemoRules(DEMO_SURFACE_ID)] });
    const state = loop.propose({ ruleId: 'stray-surface' });
    expect(state.denied!.reason).toBe('gate-error');
    expect(state.denied!.message).toContain('not renderable');
    expect(loop.adapterSnapshot().surfaces).toHaveLength(0);
    expect(loop.adapterSnapshot().issues).toHaveLength(0); // 回滚清掉了 unknown-surface 记录
  });

  it('非 JSON 帧（函数值）→ dropped-invalid，不进帧边界流', () => {
    const loop = createLoop({ rules: [SPECIAL_RULES[2]!, ...createDemoRules(DEMO_SURFACE_ID)] });
    const state = loop.propose({ ruleId: 'invalid-frame' });
    expect(loop.getLastIngestResult()!.status).toBe('dropped-invalid');
    expect(state.staged).toBeNull();
    expect(state.denied).toBeNull();
    expect(state.queueFrames).toBe(0);
    expect(loop.metrics.snapshot().global.counts.proposals).toBe(0);
  });

  it('超预算帧（300KB > maxFrameBytes 256KB）→ dropped-oversized', () => {
    const loop = createLoop({ rules: [SPECIAL_RULES[3]!, ...createDemoRules(DEMO_SURFACE_ID)] });
    const state = loop.propose({ ruleId: 'oversized-frame' });
    const ingest = loop.getLastIngestResult()!;
    expect(ingest.status).toBe('dropped-oversized');
    expect(ingest.frameBytes).toBeGreaterThan(256 * 1024);
    expect(state.staged).toBeNull();
    expect(state.queueFrames).toBe(0);
    expect(loop.metrics.snapshot().global.counts.proposals).toBe(0);
  });
});

describe('zone 锁与 supersede（v2 §9.1/§9.2）', () => {
  it('user-lock：lock 中止 staged 并回滚；锁内提议 denied(user-lock)；unlock 恢复', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm();
    loop.propose(CHIP);
    expect(loop.state().staged).not.toBeNull();

    loop.lock();
    let state = loop.state();
    expect(state.locked).toBe(true);
    expect(state.staged).toBeNull();
    expect(loop.getStagedFrame()).toBeNull();
    expect(findById(surfaceOf(loop).ir!, 'filter_chip')).toBeNull(); // staged 效果已回滚

    state = loop.propose(CHIP);
    expect(state.denied).toEqual({ reason: 'user-lock', message: 'zone is locked by user' });
    expect(zoneCounts(loop).deniedUserLock).toBe(1);

    loop.unlock();
    state = loop.propose(CHIP);
    expect(state.locked).toBe(false);
    expect(state.denied).toBeNull();
    expect(state.staged).not.toBeNull();
    assertReplayInvariant(loop);
  });

  it('supersede：新提议取代旧 staged，源帧与预览树同步切换', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm();

    loop.propose(CHIP);
    const chipFrame = loop.getStagedFrame();
    const chipStagedId = loop.state().staged!.id;

    loop.propose(DETAILS);
    const state = loop.state();
    expect(state.staged!.id).not.toBe(chipStagedId);
    expect(loop.getStagedFrame()).not.toEqual(chipFrame);
    // 预览树 = applied 基线 + 新帧（不叠加未确认的 chip）
    expect(findById(surfaceOf(loop).ir!, 'details_card')).not.toBeNull();
    expect(findById(surfaceOf(loop).ir!, 'filter_chip')).toBeNull();
    const counts = zoneCounts(loop);
    expect(counts.proposals).toBe(3);
    expect(counts.ignore).toBe(1); // chip 提案被 superseded
  });
});

describe('指标口径校准（测量装置标定，v2 §11.2）', () => {
  it('全类别脚本 → 精确计数/比率/健康判定', () => {
    const loop = createLoop();
    loop.propose(CREATE);
    loop.confirm(); // acceptAsIs
    loop.propose(CHIP);
    loop.discard(); // ignore
    loop.propose(CHIP);
    loop.noteUserEdit();
    loop.confirm(); // acceptAfterEdit
    loop.propose(DETAILS);
    loop.propose(SORT); // details 被 superseded → ignore；sort staged
    loop.confirm(); // acceptAsIs
    loop.propose(BLOCKED); // denied-blocked
    loop.revert(1); // rollback（撤 sort，恢复到 chip）
    loop.lock(); // activeLock（staged 为空，无中止）
    loop.propose(CHIP); // denied-user-lock
    loop.unlock();

    expect(zoneCounts(loop)).toEqual({
      proposals: 5,
      committed: 3,
      transformedCommitted: 0,
      acceptAsIs: 2,
      acceptAfterEdit: 1,
      autoApplied: 0,
      rollback: 1,
      ignore: 2,
      abandonedAfterEdit: 0,
      activeLock: 1,
      dormantLock: 0,
      deniedBlocked: 1,
      deniedUserLock: 1,
      edits: 1,
    });

    const zone = zoneReport(loop);
    expect(zone.rates.interactionRate).toBe(0.8);
    expect(zone.rates.directAcceptRate).toBe(0.5);
    expect(zone.rates.rollbackRate).toBeCloseTo(1 / 3, 12);
    expect(zone.rates.dormantShare).toBe(0);
    expect(zone.rates.gateBlockRate).toBeCloseTo(1 / 3, 12);
    expect(zone.rates.autoFixRate).toBe(0);
    expect(zone.health.engagementGate).toBe('pass');
    expect(zone.health.falseGreenRisk).toBe(false);
    expect(zone.everInteracted).toBe(true);

    // 终态：帧日志剪到恢复点，adapter 无 sortOrder（resync 已恢复）
    expect(loop.getCommittedFrames().map((record) => record.committedSeq)).toEqual([2, 5]);
    expect(surfaceOf(loop).dataModel['sortOrder']).toBeUndefined();
    // 单 zone：全局聚合 = zone 口径
    expect(loop.metrics.snapshot().global.counts).toEqual(zone.counts);
    assertReplayInvariant(loop);
  });
});

describe('确定性（无时钟无随机）', () => {
  it('同一脚本 ×100 恒得同一终态（状态/adapter/指标/帧日志）', () => {
    const run = (): string => {
      const loop = createLoop();
      loop.propose(CREATE);
      loop.confirm();
      loop.propose(CHIP);
      loop.discard();
      loop.propose(CHIP);
      loop.noteUserEdit();
      loop.confirm();
      loop.propose(DETAILS);
      loop.propose(SORT);
      loop.confirm();
      loop.propose(BLOCKED);
      loop.revert(1);
      loop.lock();
      loop.propose(CHIP);
      loop.unlock();
      return JSON.stringify({
        state: loop.state(),
        adapter: loop.adapterSnapshot(),
        metrics: loop.metrics.snapshot(),
        frames: loop.getCommittedFrames(),
        stagedFrame: loop.getStagedFrame(),
        ingest: loop.getLastIngestResult(),
      });
    };
    const expected = run();
    for (let i = 0; i < 100; i++) {
      expect(run()).toBe(expected);
    }
  });
});

describe('性质测试（fast-check）', () => {
  type Op =
    | { kind: 'propose'; goal: ProposerGoal }
    | { kind: 'confirm' }
    | { kind: 'discard' }
    | { kind: 'revert'; steps: number }
    | { kind: 'lock' }
    | { kind: 'unlock' }
    | { kind: 'noteUserEdit' };

  const OP_GOALS: ProposerGoal[] = [
    CREATE,
    CHIP,
    DETAILS,
    SORT,
    BLOCKED,
    { ruleId: 'garbage' },
    { ruleId: 'stray-surface' },
    { ruleId: 'invalid-frame' },
    { ruleId: 'oversized-frame' },
  ];

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constantFrom(...OP_GOALS).map((goal): Op => ({ kind: 'propose', goal })),
    fc.constant<Op>({ kind: 'confirm' }),
    fc.constant<Op>({ kind: 'discard' }),
    fc.integer({ min: 1, max: 3 }).map((steps): Op => ({ kind: 'revert', steps })),
    fc.constant<Op>({ kind: 'lock' }),
    fc.constant<Op>({ kind: 'unlock' }),
    fc.constant<Op>({ kind: 'noteUserEdit' }),
  );

  function propertyLoop(): ClosedLoop {
    return new ClosedLoop({
      rules: [...SPECIAL_RULES, ...createDemoRules(DEMO_SURFACE_ID)],
      surfaceId: DEMO_SURFACE_ID,
    });
  }

  function applyOp(loop: ClosedLoop, op: Op): void {
    switch (op.kind) {
      case 'propose':
        loop.propose(op.goal);
        break;
      case 'confirm':
        loop.confirm();
        break;
      case 'discard':
        loop.discard();
        break;
      case 'revert':
        loop.revert(op.steps);
        break;
      case 'lock':
        loop.lock();
        break;
      case 'unlock':
        loop.unlock();
        break;
      case 'noteUserEdit':
        loop.noteUserEdit();
        break;
    }
  }

  it('重放不变量 ×100：任意操作序列后 adapter ≡ committed(+staged) 重放', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 24 }), (ops) => {
        const loop = propertyLoop();
        for (const op of ops) {
          applyOp(loop, op);
          assertReplayInvariant(loop);
        }
      }),
      { numRuns: 100 },
    );
  }, 30_000);

  it('确定性 ×100：同一操作序列双执行恒得同一终态', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 24 }), (ops) => {
        const a = propertyLoop();
        const b = propertyLoop();
        for (const op of ops) {
          applyOp(a, op);
          applyOp(b, op);
        }
        expect(JSON.stringify(a.state())).toBe(JSON.stringify(b.state()));
        expect(JSON.stringify(a.adapterSnapshot())).toBe(JSON.stringify(b.adapterSnapshot()));
        expect(JSON.stringify(a.metrics.snapshot())).toBe(JSON.stringify(b.metrics.snapshot()));
        expect(JSON.stringify(a.getCommittedFrames())).toBe(JSON.stringify(b.getCommittedFrames()));
      }),
      { numRuns: 100 },
    );
  }, 30_000);
});
