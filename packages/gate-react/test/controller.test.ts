import { gate } from '@genui/gate';
import type { GateResult, VerdictAction } from '@genui/gate';
import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { PendingFrameQueue, ProposalSession, SessionMetrics } from '@genui/session';
import type { ArbitrationRequest, MetricsSnapshot } from '@genui/session';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { GateSurfaceController } from '../src/controller';
import type { GateSurfaceOptions, SurfaceState } from '../src/controller';

function node(id: string, slots: Record<string, IRNode[]> = {}): IRNode {
  return { id, type: 'Panel', props: { text: id }, slots };
}

function mkGate(ir: IRNode, verdict: VerdictAction = 'pass'): GateResult {
  return { ir, verdict, trace: [] };
}

/** 帧 payload = {n, verdict}；「帧 → IR + gate」的解析契约由宿主实现，测试用确定性桩 */
function specEvaluate(payload: JsonValue): GateResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return mkGate(node('invalid'), 'block');
  }
  const { n, verdict } = payload;
  if (typeof n !== 'number' || typeof verdict !== 'string') {
    return mkGate(node('invalid'), 'block');
  }
  if (verdict !== 'pass' && verdict !== 'transform' && verdict !== 'requireApproval' && verdict !== 'block') {
    return mkGate(node('invalid'), 'block');
  }
  return mkGate(node(`n${n}`), verdict);
}

function frame(n: number, verdict: VerdictAction): JsonObject {
  return { n, verdict };
}

interface Wired {
  controller: GateSurfaceController;
  session: ProposalSession;
  metrics: SessionMetrics;
}

function wired(autoCommit = false, arbitration?: ArbitrationRequest): Wired {
  const metrics = new SessionMetrics();
  const session = new ProposalSession({ onEvent: metrics.onEvent });
  const controller = new GateSurfaceController({
    zone: 'main',
    session,
    evaluate: specEvaluate,
    autoCommit,
    arbitration,
  });
  return { controller, session, metrics };
}

describe('constructor', () => {
  it('非法参数 fail-fast', () => {
    const session = new ProposalSession();
    const base: GateSurfaceOptions = { zone: 'main', session, evaluate: specEvaluate };
    expect(() => new GateSurfaceController(Object.assign({}, base, { zone: '' }))).toThrow(RangeError);
    expect(() => new GateSurfaceController(Object.assign({}, base, { evaluate: 42 }))).toThrow(TypeError);
    expect(() => new GateSurfaceController(Object.assign({}, base, { session: { stage: 1, commit: 2 } }))).toThrow(
      TypeError,
    );
  });

  it('初始快照字段 + 引用稳定', () => {
    const { controller } = wired();
    const state = controller.getSnapshot();
    expect(state.zone).toBe('main');
    expect(state.applied).toBeNull();
    expect(state.staged).toBeNull();
    expect(state.denied).toBeNull();
    expect(state.locked).toBe(false);
    expect(state.queueFrames).toBe(0);
    expect(state.resyncRequired).toBe(false);
    expect(controller.getSnapshot()).toBe(state);
  });
});

describe('帧管线（takeOldest + stage 消费点，v2 §5.2）', () => {
  it('ingest + processQueue：staged 为最新帧（单写者 supersede），队列清空', () => {
    const { controller, metrics } = wired();
    controller.ingestFrame(frame(1, 'pass'));
    controller.ingestFrame(frame(2, 'pass'));
    expect(controller.getSnapshot().queueFrames).toBe(2);
    expect(controller.processQueue()).toBe(2);
    const state = controller.getSnapshot();
    expect(state.queueFrames).toBe(0);
    expect(state.staged?.irPrime.id).toBe('n2');
    const kinds = metrics.snapshot().eventLog.map((entry) => entry.event.kind);
    expect(kinds).toEqual(['staged', 'staged-aborted', 'staged']);
  });

  it('空队列 processQueue 为 no-op，快照引用不变', () => {
    const { controller } = wired();
    const before = controller.getSnapshot();
    expect(controller.processQueue()).toBe(0);
    expect(controller.getSnapshot()).toBe(before);
  });

  it('block → denied，不产生 staged', () => {
    const { controller, metrics } = wired();
    controller.ingestFrame(frame(1, 'block'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.staged).toBeNull();
    expect(state.denied).toEqual({ reason: 'blocked', message: 'Proposal blocked by gate' });
    expect(metrics.snapshot().eventLog.some((entry) => entry.event.kind === 'stage-denied')).toBe(true);
  });

  it('user-lock 拒绝，unlock 后恢复', () => {
    const { controller } = wired();
    controller.lock();
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    expect(controller.getSnapshot().denied).toEqual({
      reason: 'user-lock',
      message: 'Zone is locked by user',
    });
    controller.unlock();
    controller.ingestFrame(frame(2, 'pass'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.denied).toBeNull();
    expect(state.staged?.irPrime.id).toBe('n2');
  });

  it('evaluate 抛错：单帧 quarantine（gate-error），队列继续', () => {
    const metrics = new SessionMetrics();
    const session = new ProposalSession({ onEvent: metrics.onEvent });
    let mode: 'throw' | 'ok' = 'throw';
    const evaluate = (payload: JsonValue): GateResult => {
      if (mode === 'throw') throw new Error('boom');
      return specEvaluate(payload);
    };
    const controller = new GateSurfaceController({ zone: 'main', session, evaluate });
    controller.ingestFrame(frame(1, 'pass'));
    controller.ingestFrame(frame(2, 'pass'));
    expect(controller.processQueue()).toBe(2);
    expect(controller.getSnapshot().denied).toEqual({
      reason: 'gate-error',
      message: 'Gate evaluation failed: boom',
    });
    mode = 'ok';
    controller.ingestFrame(frame(3, 'pass'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.denied).toBeNull();
    expect(state.staged?.irPrime.id).toBe('n3');
  });

  it('非 Error 抛出物也有确定性信息', () => {
    const session = new ProposalSession();
    const controller = new GateSurfaceController({
      zone: 'main',
      session,
      evaluate: (): GateResult => {
        throw 'plain string';
      },
    });
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    expect(controller.getSnapshot().denied).toEqual({
      reason: 'gate-error',
      message: 'Gate evaluation failed: plain string',
    });
  });
});

describe('autoCommit（v2 §5.2 流式语义：pass/transform 帧边界摘除 inert）', () => {
  it('pass 帧直接应用，指标记 autoApplied（userConfirmed=false）', () => {
    const { controller, metrics } = wired(true, { platformPolicy: 'auto' });
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.staged).toBeNull();
    expect(state.applied?.irPrime.id).toBe('n1');
    const report = metrics.snapshot().zones.find((z) => z.zone === 'main');
    expect(report?.counts.autoApplied).toBe(1);
    expect(report?.counts.committed).toBe(1);
    const committed = metrics.snapshot().eventLog.find((entry) => entry.event.kind === 'committed');
    expect(committed?.event.kind === 'committed' ? committed.event.userConfirmed : true).toBe(false);
  });

  it('transform 帧同样自动应用', () => {
    const { controller } = wired(true, { platformPolicy: 'auto' });
    controller.ingestFrame(frame(1, 'transform'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.staged).toBeNull();
    expect(state.applied?.irPrime.id).toBe('n1');
  });

  it('requireApproval 永不自动应用（摘除 inert 必须经过人工确认）', () => {
    const { controller } = wired(true, { platformPolicy: 'auto' });
    controller.ingestFrame(frame(1, 'requireApproval'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.staged?.verdict).toBe('requireApproval');
    expect(state.applied).toBeNull();
  });

  it('保守默认 user-confirm 下 autoCommit 不生效（§9.2 默认优先）', () => {
    const { controller } = wired(true);
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    const state = controller.getSnapshot();
    expect(state.staged?.irPrime.id).toBe('n1');
    expect(state.applied).toBeNull();
  });
});

describe('人工确认 / 拒绝 / 回滚', () => {
  it('confirm() → applied，指标 acceptAsIs + userConfirmed=true', () => {
    const { controller, metrics } = wired();
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    const result = controller.confirm();
    expect(result.status).toBe('committed');
    const state = controller.getSnapshot();
    expect(state.staged).toBeNull();
    expect(state.applied?.irPrime.id).toBe('n1');
    const snapshot = metrics.snapshot();
    const report = snapshot.zones.find((z) => z.zone === 'main');
    expect(report?.counts.acceptAsIs).toBe(1);
    const committed = snapshot.eventLog.find((entry) => entry.event.kind === 'committed');
    expect(committed?.event.kind === 'committed' ? committed.event.userConfirmed : false).toBe(true);
  });

  it('abortPreview() → 回到无 staged', () => {
    const { controller } = wired();
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    const result = controller.abortPreview();
    expect(result.status).toBe('aborted');
    const state = controller.getSnapshot();
    expect(state.staged).toBeNull();
    expect(state.applied).toBeNull();
  });

  it('revert 恢复上一版 applied', () => {
    const { controller } = wired(true, { platformPolicy: 'auto' });
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    controller.ingestFrame(frame(2, 'pass'));
    controller.processQueue();
    expect(controller.getSnapshot().applied?.irPrime.id).toBe('n2');
    const result = controller.revert(1);
    expect(result.status).toBe('reverted');
    expect(controller.getSnapshot().applied?.irPrime.id).toBe('n1');
  });

  it('revert 无快照时 no-snapshot（不抛错）', () => {
    const { controller } = wired();
    const result = controller.revert();
    expect(result.status).toBe('no-snapshot');
  });
});

describe('背压与重同步', () => {
  it('溢出 → resyncRequired 透出；clearQueue 复位', () => {
    const { controller } = wired();
    for (let i = 0; i < 101; i += 1) {
      controller.ingestFrame(frame(i, 'pass'));
    }
    const state = controller.getSnapshot();
    expect(state.queueFrames).toBe(100);
    expect(state.resyncRequired).toBe(true);
    controller.clearQueue();
    const after = controller.getSnapshot();
    expect(after.queueFrames).toBe(0);
    expect(after.resyncRequired).toBe(false);
  });

  it('自定义 queue 生效', () => {
    const session = new ProposalSession();
    const queue = new PendingFrameQueue({ maxQueueFrames: 2 });
    const controller = new GateSurfaceController({ zone: 'main', session, evaluate: specEvaluate, queue });
    for (let i = 0; i < 3; i += 1) {
      controller.ingestFrame(frame(i, 'pass'));
    }
    const state = controller.getSnapshot();
    expect(state.queueFrames).toBe(2);
    expect(state.resyncRequired).toBe(true);
  });
});

describe('订阅', () => {
  it('状态变化通知订阅者；同一状态不重发；退订后不再通知', () => {
    const { controller } = wired();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.ingestFrame(frame(1, 'pass'));
    expect(listener).toHaveBeenCalledTimes(1);
    controller.processQueue();
    expect(listener).toHaveBeenCalledTimes(2);
    controller.processQueue();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    controller.ingestFrame(frame(2, 'pass'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('真实 gate 集成', () => {
  it('gate() 产物直达 stage：预览与 gate 输出同一 IR′ 引用（KAN-025）', () => {
    const session = new ProposalSession();
    const tree = node('real-1');
    const results: GateResult[] = [gate(tree)];
    let call = 0;
    const controller = new GateSurfaceController({
      zone: 'main',
      session,
      evaluate: (payload: JsonValue): GateResult => {
        void payload;
        const result = results[call];
        call += 1;
        if (result === undefined) throw new Error('no more results');
        return result;
      },
    });
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    const staged = controller.getSnapshot().staged;
    expect(staged?.irPrime).toBe(results[0]?.ir);
    expect(staged?.verdict).toBe('pass');
  });
});

describe('确定性', () => {
  type Cmd =
    | { kind: 'ingest'; n: number; verdict: VerdictAction }
    | { kind: 'process' }
    | { kind: 'confirm' }
    | { kind: 'abort' }
    | { kind: 'revert'; steps: 1 | 2 }
    | { kind: 'lock' }
    | { kind: 'unlock' }
    | { kind: 'clear' };

  const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({
      kind: fc.constant('ingest'),
      n: fc.nat(30),
      verdict: fc.constantFrom<VerdictAction>('pass', 'transform', 'requireApproval', 'block'),
    }),
    fc.record({ kind: fc.constant('process') }),
    fc.record({ kind: fc.constant('confirm') }),
    fc.record({ kind: fc.constant('abort') }),
    fc.record({ kind: fc.constant('revert'), steps: fc.constantFrom(1 as const, 2 as const) }),
    fc.record({ kind: fc.constant('lock') }),
    fc.record({ kind: fc.constant('unlock') }),
    fc.record({ kind: fc.constant('clear') }),
  );

  function replay(cmds: readonly Cmd[], autoCommit: boolean): { state: SurfaceState; snapshot: MetricsSnapshot } {
    const metrics = new SessionMetrics();
    const session = new ProposalSession({ onEvent: metrics.onEvent });
    const controller = new GateSurfaceController({
      zone: 'main',
      session,
      evaluate: specEvaluate,
      autoCommit,
    });
    for (const cmd of cmds) {
      switch (cmd.kind) {
        case 'ingest':
          controller.ingestFrame(frame(cmd.n, cmd.verdict));
          break;
        case 'process':
          controller.processQueue();
          break;
        case 'confirm':
          controller.confirm();
          break;
        case 'abort':
          controller.abortPreview();
          break;
        case 'revert':
          controller.revert(cmd.steps);
          break;
        case 'lock':
          controller.lock();
          break;
        case 'unlock':
          controller.unlock();
          break;
        case 'clear':
          controller.clearQueue();
          break;
      }
    }
    return { state: controller.getSnapshot(), snapshot: metrics.snapshot() };
  }

  it('×200：同一命令序列两实例 → 状态与指标快照 deep-equal', () => {
    const prop = fc.property(
      fc.record({ autoCommit: fc.boolean(), cmds: fc.array(cmdArb, { maxLength: 40 }) }),
      ({ autoCommit, cmds }) => {
        const a = replay(cmds, autoCommit);
        const b = replay(cmds, autoCommit);
        expect(a.state).toEqual(b.state);
        expect(a.snapshot).toEqual(b.snapshot);
      },
    );
    fc.assert(prop, { numRuns: 200 });
  }, 30_000);
});
