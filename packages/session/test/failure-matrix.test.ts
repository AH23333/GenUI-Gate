import type { GateResult } from '@genui/gate';
import type { VerdictAction } from '@genui/gate';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IRNode, JsonObject } from '@genui/ir';
import { SessionMetrics } from '../src/metrics';
import { ProposalSession } from '../src/proposal';
import type { SessionEvent } from '../src/types';

/**
 * 失败矩阵黄金测试（v2 §14，session 包）——每行一个黄金断言组，快照级进 CI。
 *
 * §14 行 → session 包落地映射（M1）：
 * - 「快照恢复哈希不匹配」行 → ProposalSession.revert 恢复前校验 irPrimeHash
 *   （proposal.ts:207），失配 → snapshot-corrupted：该条移出环形、applied 保持、
 *   事件流可观测、状态机继续可用。本文件以精确事件序列 + 精确结果对象钉死该行为。
 * - 「telemetry 上报失败」行 → OSS 重释（v3 §11 零网络出口）：SessionMetrics 仅内存
 *   聚合，无上报通道，「上报失败」不可发生。相邻失效模式 = 事件日志溢出：
 *   有界降级（默认 100 条，丢最旧，seq 间隙可观测），计数零污染。
 * - 「持久化损坏」行 → M1 无持久化（快照仅内存环形缓冲），该行不适用；
 *   其威胁（持久层篡改）由 snapshot 行的防投毒校验覆盖。
 */

function node(
  id: string,
  type: string,
  props: JsonObject = {},
  slots: Record<string, IRNode[]> = {},
): IRNode {
  return { id, type, props, slots };
}

function mkGate(ir: IRNode, verdict: VerdictAction, trace: GateResult['trace'] = []): GateResult {
  return { ir, verdict, trace };
}

const T1 = node('t1', 'Column', { v: 1 });
const T2 = node('t2', 'Column', { v: 2 });

interface Wired {
  session: ProposalSession;
  metrics: SessionMetrics;
  events: SessionEvent[];
}

/** 全链接线：session 事件 → metrics 聚合 + 显式事件流收集（1.8 口径） */
function wired(): Wired {
  const events: SessionEvent[] = [];
  const metrics = new SessionMetrics();
  const session = new ProposalSession({
    onEvent: (event) => {
      events.push(event);
      metrics.onEvent(event);
    },
  });
  return { session, metrics, events };
}

describe('snapshot 行：恢复哈希不匹配 → 丢弃该快照（§14 防投毒）', () => {
  it('黄金快照：篡改目标快照 IR′ → snapshot-corrupted 精确结果 + 精确事件序列 + applied 不变 + 深度回退', () => {
    const poisonTree = node('poison', 'Column', { v: 1 });
    const { session, events, metrics } = wired();
    session.stage('z', mkGate(poisonTree, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const c2 = session.commit('z', {});
    const before = events.map((e) => e.kind);
    expect(before).toEqual(['staged', 'committed', 'staged', 'committed']);

    // 投毒：篡改回滚目标（ring[0]）的 IR′ 内容
    poisonTree.props.v = 999;

    const result = session.revert('z');
    // 精确结果对象（§14：不恢复、不崩溃、可观测）
    expect(result).toEqual({
      status: 'snapshot-corrupted',
      snapshot: null,
      revertedProposalId: null,
      cancelledInflight: 0,
    });
    // 精确事件序列：仅追加一条 revert-failed（snapshot-corrupted），无其他副作用事件
    expect(events.slice(4)).toEqual([
      { kind: 'revert-failed', zone: 'z', reason: 'snapshot-corrupted', steps: 1 },
    ]);
    // applied 保持被篡改前状态；污染条目移出环形 → 深度回退
    expect(session.getApplied('z')).toBe(c2.proposal);
    expect(session.getRevertDepth('z')).toBe(0);
    // metrics 可观测：revert-failed 不计入 rollback（§11.2 只记成功的 reverted）
    const counts = metrics.snapshot().zones[0]!.counts;
    expect(counts.rollback).toBe(0);
    expect(counts.committed).toBe(2);
    // 状态机继续可用（fail-closed 不 fail-dead）
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    expect(session.commit('z', {}).status).toBe('committed');
  });

  it('确定性重放：同一操作序列（含投毒）跑两次 → 事件流与终态逐字段全等', () => {
    const run = (): { kinds: string[]; appliedId: string | null; depth: number } => {
      const poisonTree = node('poison', 'Column', { v: 1 });
      const { session, events } = wired();
      session.stage('z', mkGate(poisonTree, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
      session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
      poisonTree.props.v = 999;
      session.revert('z');
      return {
        kinds: events.map((e) => e.kind),
        appliedId: session.getApplied('z')?.id ?? null,
        depth: session.getRevertDepth('z'),
      };
    };
    expect(run()).toEqual(run());
  });
});

describe('telemetry 行：上报失败 → OSS 零出口重释为日志溢出有界降级（§14）', () => {
  it('黄金快照：默认容量 100，第 105 个事件后 → 恰 100 条、首 seq 6、相邻 seq 连续、计数零污染', () => {
    const metrics = new SessionMetrics(); // 生产默认：maxEventLog = 100
    // 105 个无计数副作用的事件（zone-unlocked 仅入日志）
    for (let i = 0; i < 105; i += 1) {
      metrics.onEvent({ kind: 'zone-unlocked', zone: 'z' });
    }
    const snapshot = metrics.snapshot();
    // 有界降级：丢最旧 5 条，seq 间隙（1..5 缺席）即降级可观测性
    expect(snapshot.eventLog).toHaveLength(100);
    expect(snapshot.eventLog[0]!.seq).toBe(6);
    expect(snapshot.eventLog.at(-1)!.seq).toBe(105);
    expect(snapshot.eventLog.every((entry) => entry.event.kind === 'zone-unlocked')).toBe(true);
    for (let i = 1; i < snapshot.eventLog.length; i += 1) {
      expect(snapshot.eventLog[i]!.seq).toBe(snapshot.eventLog[i - 1]!.seq + 1);
    }
    // 降级不污染计数：zone-unlocked 无计数语义，zones 报告为空
    expect(snapshot.zones).toEqual([]);
    expect(snapshot.global.counts.proposals).toBe(0);
  });

  it('性质：任意事件序列下 eventLog 恒有界且 seq 单调无重排（×100）', () => {
    const eventArb = fc.constantFrom<SessionEvent>(
      { kind: 'zone-unlocked', zone: 'z' },
      { kind: 'zone-locked', zone: 'z', abortedStagedId: null },
    );
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 500 }), (events) => {
        const metrics = new SessionMetrics();
        for (const event of events) metrics.onEvent(event);
        const log = metrics.snapshot().eventLog;
        expect(log.length).toBeLessThanOrEqual(100);
        expect(log.length).toBe(Math.min(events.length, 100));
        for (let i = 1; i < log.length; i += 1) {
          expect(log[i]!.seq).toBe(log[i - 1]!.seq + 1);
        }
        if (log.length > 0) {
          const dropped = events.length - log.length;
          expect(log[0]!.seq).toBe(dropped + 1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
