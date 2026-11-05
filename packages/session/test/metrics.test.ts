import type { GateResult, VerdictAction } from '@genui/gate';
import type { IRNode, JsonObject } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ConfirmationPolicy } from '../src/arbitration';
import { GLOBAL_ZONE, SessionMetrics } from '../src/metrics';
import type { InteractionCounts, MetricsSnapshot, SessionMetricsOptions, ZoneReport } from '../src/metrics';
import { ProposalSession } from '../src/proposal';
import type { SessionEvent } from '../src/types';

const POLICIES: ConfirmationPolicy[] = ['user-confirm', 'auto', 'never'];

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

const T1 = node('t1', 'Column', { v: 1 }, { default: [node('t1a', 'Text', { c: 'x' })] });
const T2 = node('t2', 'Column', { v: 2 }, { default: [node('t2a', 'Text', { c: 'y' })] });
const T3 = node('t3', 'Stack', { v: 3 }, { footer: [node('t3a', 'Text')] });
const TREES: IRNode[] = [T1, T2, T3];

/** 宿主标准接线：ProposalSession 事件流直连 SessionMetrics.onEvent（绑定箭头，可直接传） */
function wired(options?: SessionMetricsOptions): { session: ProposalSession; metrics: SessionMetrics } {
  const metrics = new SessionMetrics(options);
  const session = new ProposalSession({ onEvent: metrics.onEvent });
  return { session, metrics };
}

function zoneReport(snapshot: MetricsSnapshot, zone: string): ZoneReport {
  const report = snapshot.zones.find((r) => r.zone === zone);
  if (report === undefined) throw new Error(`missing zone report: ${zone}`);
  return report;
}

const COUNT_KEYS: Array<keyof InteractionCounts> = [
  'proposals',
  'committed',
  'transformedCommitted',
  'acceptAsIs',
  'acceptAfterEdit',
  'autoApplied',
  'rollback',
  'ignore',
  'abandonedAfterEdit',
  'activeLock',
  'dormantLock',
  'deniedBlocked',
  'deniedUserLock',
  'edits',
];

/** 全局聚合 = 各 zone 计数之和（v2 §11.2 组合口径按全局事件流聚合） */
function expectGlobalSums(snapshot: MetricsSnapshot): void {
  for (const key of COUNT_KEYS) {
    expect(snapshot.global.counts[key]).toBe(snapshot.zones.reduce((acc, z) => acc + z.counts[key], 0));
  }
  expect(snapshot.global.everInteracted).toBe(snapshot.zones.some((z) => z.everInteracted));
}

describe('constructor', () => {
  it('默认与自定义合法参数均可构造', () => {
    expect(() => new SessionMetrics()).not.toThrow();
    expect(() => new SessionMetrics({})).not.toThrow();
    expect(
      () => new SessionMetrics({ engagementThreshold: 0.5, rollbackThreshold: 0.1, maxEventLog: 7, perfSampleEvery: 3 }),
    ).not.toThrow();
    expect(() => new SessionMetrics({ engagementThreshold: 1, rollbackThreshold: 0.001 })).not.toThrow();
  });

  it('engagementThreshold/rollbackThreshold 超出 (0,1] → RangeError', () => {
    expect(() => new SessionMetrics({ engagementThreshold: 0 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ engagementThreshold: -0.1 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ engagementThreshold: 1.5 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ engagementThreshold: Number.NaN })).toThrow(RangeError);
    expect(() => new SessionMetrics({ rollbackThreshold: 0 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ rollbackThreshold: 2 })).toThrow(RangeError);
  });

  it('maxEventLog/perfSampleEvery 非正整数 → RangeError', () => {
    expect(() => new SessionMetrics({ maxEventLog: 0 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ maxEventLog: -1 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ maxEventLog: 1.5 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ perfSampleEvery: 0 })).toThrow(RangeError);
    expect(() => new SessionMetrics({ perfSampleEvery: 2.5 })).toThrow(RangeError);
  });
});

describe('交互分类（v2 §11.2，反 gaming：不采信 Agent 自评）', () => {
  it('acceptAsIs：确认且未编辑；接线 metrics.onEvent 直接生效', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', { confirmed: true });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts).toMatchObject({
      proposals: 1,
      committed: 1,
      acceptAsIs: 1,
      acceptAfterEdit: 0,
      autoApplied: 0,
      rollback: 0,
      ignore: 0,
      abandonedAfterEdit: 0,
    });
    expect(report.everInteracted).toBe(true);
    expect(report.pendingProposalId).toBeNull();
  });

  it('acceptAfterEdit：编辑后确认（noteUserEdit 标记 pending）', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    metrics.noteUserEdit('z');
    session.commit('z', { confirmed: true });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.acceptAfterEdit).toBe(1);
    expect(report.counts.acceptAsIs).toBe(0);
    expect(report.counts.edits).toBe(1);
    expect(report.everInteracted).toBe(true);
  });

  it('autoApplied：未带确认的 commit 单列，不进交互分子（Agent 自评不算用户交互）', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.autoApplied).toBe(1);
    expect(report.counts.acceptAsIs).toBe(0);
    expect(report.everInteracted).toBe(false);
    expect(report.rates.interactionRate).toBe(0);
  });

  it('rollback：按 revert 步数累计（一次 revert 多步 = 多个提案被回滚）', () => {
    const { session, metrics } = wired();
    for (const tree of [T1, T2, T3]) {
      session.stage('z', mkGate(tree, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
    }
    session.revert('z', 2);
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.rollback).toBe(2);
    expect(report.counts.committed).toBe(3);
    expect(report.rates.rollbackRate).toBeCloseTo(2 / 3, 12);
    expect(report.everInteracted).toBe(true);
  });

  it('ignore：被新提案取代 / 用户 abort，零交互', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.abort('z');
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.ignore).toBe(2);
    expect(report.counts.proposals).toBe(2);
    expect(report.everInteracted).toBe(false);
  });

  it('abandonedAfterEdit：编辑后放弃（补集诊断量，五类之外）', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    metrics.noteUserEdit('z');
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.abandonedAfterEdit).toBe(1);
    expect(report.counts.ignore).toBe(0);
    expect(report.everInteracted).toBe(true);
  });

  it('dormantLock：零交互 zone 上锁定', () => {
    const { session, metrics } = wired();
    session.lockZone('z');
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.dormantLock).toBe(1);
    expect(report.counts.activeLock).toBe(0);
    expect(report.rates.dormantShare).toBe(1);
    expect(report.everInteracted).toBe(false);
  });

  it('activeLock：此前的 accept 使锁定为 active', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', { confirmed: true });
    session.lockZone('z');
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.activeLock).toBe(1);
    expect(report.counts.dormantLock).toBe(0);
    expect(report.rates.dormantShare).toBe(0);
  });

  it('activeLock：仅编辑（未 accept）也计为该 zone 的交互', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    metrics.noteUserEdit('z');
    session.abort('z');
    session.lockZone('z');
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.activeLock).toBe(1);
    expect(report.counts.abandonedAfterEdit).toBe(1);
  });

  it('deniedBlocked：gate block 拒绝单列；gateBlockRate = deniedBlocked / committed（可超过 1）', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T2, 'block'), {});
    session.stage('z', mkGate(T3, 'block'), {});
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.deniedBlocked).toBe(2);
    expect(report.counts.proposals).toBe(1);
    expect(report.rates.gateBlockRate).toBe(2);
  });

  it('deniedUserLock：锁定后 stage 被拒', () => {
    const { session, metrics } = wired();
    session.lockZone('z');
    session.stage('z', mkGate(T1, 'pass'), {});
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.deniedUserLock).toBe(1);
    expect(report.counts.dormantLock).toBe(1);
    expect(report.counts.proposals).toBe(0);
  });

  it('transformedCommitted 仅计 verdict=transform 且已 commit 的提案（autoFixRate）', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'transform'), { agentRequest: 'auto' });
    session.abort('z');
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    expect(zoneReport(metrics.snapshot(), 'z').rates.autoFixRate).toBe(0);
    session.stage('z', mkGate(T3, 'transform'), { agentRequest: 'auto' });
    session.commit('z', {});
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.transformedCommitted).toBe(1);
    expect(report.counts.committed).toBe(2);
    expect(report.rates.autoFixRate).toBeCloseTo(1 / 2, 12);
  });

  it('防御：未见 staged 的 committed（宿主事件流缺序）仍归类且计数 committed', () => {
    const metrics = new SessionMetrics();
    metrics.onEvent({ kind: 'committed', zone: 'z', proposalId: 'pX', committedSeq: 1, supersededId: null, userConfirmed: false });
    expect(zoneReport(metrics.snapshot(), 'z').counts.autoApplied).toBe(1);
    metrics.onEvent({ kind: 'committed', zone: 'z', proposalId: 'pY', committedSeq: 2, supersededId: null, userConfirmed: true });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.acceptAsIs).toBe(1);
    expect(report.counts.committed).toBe(2);
    expect(report.everInteracted).toBe(true);
  });

  it('stage 被拒不清空 pending：原 pending 提案仍可归类', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.stage('z', mkGate(T2, 'block'), {});
    expect(zoneReport(metrics.snapshot(), 'z').pendingProposalId).toBe('p1');
    session.commit('z', { confirmed: true });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.acceptAsIs).toBe(1);
    expect(report.counts.proposals).toBe(1);
    expect(report.counts.deniedBlocked).toBe(1);
  });
});

describe('健康口径与假绿判定（v2 §11.2/§17-P1 出口③）', () => {
  it('假绿用例：低交互（全 autoApplied）+ 低回滚 → engagementGate fail 且 falseGreenRisk', () => {
    const { session, metrics } = wired();
    for (let i = 0; i < 10; i += 1) {
      session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
    }
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.autoApplied).toBe(10);
    expect(report.rates.interactionRate).toBe(0);
    expect(report.rates.rollbackRate).toBe(0);
    expect(report.health.engagementGate).toBe('fail');
    expect(report.health.falseGreenRisk).toBe(true);
  });

  it('高交互 + 低回滚 → pass，无假绿风险', () => {
    const { session, metrics } = wired();
    for (let i = 0; i < 10; i += 1) {
      session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      session.commit('z', { confirmed: true });
    }
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.rates.interactionRate).toBe(1);
    expect(report.health.engagementGate).toBe('pass');
    expect(report.health.falseGreenRisk).toBe(false);
  });

  it('低交互 + 高回滚（回滚证据诚实）→ fail 但非假绿', () => {
    const { session, metrics } = wired();
    for (let i = 0; i < 20; i += 1) {
      session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
    }
    session.revert('z', 5);
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.rates.interactionRate).toBeCloseTo(5 / 20, 12);
    expect(report.rates.rollbackRate).toBeCloseTo(5 / 20, 12);
    expect(report.health.engagementGate).toBe('fail');
    expect(report.health.falseGreenRisk).toBe(false);
  });

  it('低交互且无 commit（rollbackRate null，无回滚证据）→ fail 但非假绿', () => {
    const { session, metrics } = wired();
    for (let i = 0; i < 3; i += 1) {
      session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      session.abort('z');
    }
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.ignore).toBe(3);
    expect(report.rates.rollbackRate).toBeNull();
    expect(report.health.engagementGate).toBe('fail');
    expect(report.health.falseGreenRisk).toBe(false);
  });

  it('空快照：全计数 0、全比率 null、insufficient-data', () => {
    const metrics = new SessionMetrics();
    const snapshot = metrics.snapshot();
    expect(snapshot.zones).toEqual([]);
    expect(snapshot.eventLog).toEqual([]);
    expect(snapshot.perf).toEqual([]);
    expect(snapshot.global.zone).toBe(GLOBAL_ZONE);
    expect(snapshot.global.everInteracted).toBe(false);
    expect(snapshot.global.pendingProposalId).toBeNull();
    for (const key of COUNT_KEYS) {
      expect(snapshot.global.counts[key]).toBe(0);
    }
    expect(snapshot.global.rates).toEqual({
      interactionRate: null,
      directAcceptRate: null,
      rollbackRate: null,
      dormantShare: null,
      gateBlockRate: null,
      autoFixRate: null,
    });
    expect(snapshot.global.health).toEqual({ engagementGate: 'insufficient-data', falseGreenRisk: false });
  });

  it('阈值边界：interactionRate 恰等于 engagementThreshold → pass；自定义阈值生效', () => {
    const boundary = wired();
    for (let i = 0; i < 10; i += 1) {
      boundary.session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      if (i < 3) {
        boundary.session.commit('z', { confirmed: true });
      } else {
        boundary.session.abort('z');
      }
    }
    expect(zoneReport(boundary.metrics.snapshot(), 'z').rates.interactionRate).toBeCloseTo(0.3, 12);
    expect(zoneReport(boundary.metrics.snapshot(), 'z').health.engagementGate).toBe('pass');

    const custom = wired({ engagementThreshold: 0.5, rollbackThreshold: 0.5 });
    for (let i = 0; i < 10; i += 1) {
      custom.session.stage('z', mkGate(TREES[i % 3]!, 'pass'), { agentRequest: 'auto' });
      custom.session.commit('z', i < 4 ? { confirmed: true } : {});
    }
    const report = zoneReport(custom.metrics.snapshot(), 'z');
    expect(report.rates.interactionRate).toBeCloseTo(0.4, 12);
    expect(report.health.engagementGate).toBe('fail');
    expect(report.rates.rollbackRate).toBe(0);
    expect(report.health.falseGreenRisk).toBe(true);
  });

  it('混合事件流：各比率公式逐项核对', () => {
    const { session, metrics } = wired();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', { confirmed: true });
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    metrics.noteUserEdit('z');
    session.commit('z', { confirmed: true });
    session.stage('z', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', { confirmed: true });
    session.revert('z', 1);
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.abort('z');
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts).toMatchObject({
      proposals: 5,
      committed: 4,
      acceptAsIs: 2,
      acceptAfterEdit: 1,
      autoApplied: 1,
      rollback: 1,
      ignore: 1,
    });
    expect(report.rates.interactionRate).toBeCloseTo(4 / 5, 12);
    expect(report.rates.directAcceptRate).toBeCloseTo(2 / 4, 12);
    expect(report.rates.rollbackRate).toBeCloseTo(1 / 4, 12);
    expect(report.rates.gateBlockRate).toBe(0);
    expect(report.rates.autoFixRate).toBe(0);
    expect(report.rates.dormantShare).toBeNull();
    expect(report.health.engagementGate).toBe('pass');
  });

  it('dormantShare 按 zone 独立；全局聚合 = 各 zone 之和', () => {
    const { session, metrics } = wired();
    session.lockZone('a');
    session.stage('b', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('b', { confirmed: true });
    session.lockZone('b');
    const snapshot = metrics.snapshot();
    expect(zoneReport(snapshot, 'a').rates.dormantShare).toBe(1);
    expect(zoneReport(snapshot, 'b').rates.dormantShare).toBe(0);
    expect(snapshot.global.counts.dormantLock).toBe(1);
    expect(snapshot.global.counts.activeLock).toBe(1);
    expect(snapshot.global.rates.dormantShare).toBeCloseTo(1 / 2, 12);
    expectGlobalSums(snapshot);
  });
});

describe('事件日志（有界，确定性 seq）', () => {
  it('默认容量 100：溢出丢最旧，seq 连续且单调', () => {
    const metrics = new SessionMetrics();
    for (let i = 0; i < 105; i += 1) {
      metrics.onEvent({ kind: 'zone-unlocked', zone: 'z' });
    }
    const log = metrics.snapshot().eventLog;
    expect(log).toHaveLength(100);
    expect(log[0]!.seq).toBe(6);
    expect(log[99]!.seq).toBe(105);
    expect(log[99]!.event).toEqual({ kind: 'zone-unlocked', zone: 'z' });
  });

  it('自定义容量 3：仅保留最近事件，按发生序（最旧在前）', () => {
    const { session, metrics } = wired({ maxEventLog: 3 });
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', { confirmed: true });
    session.lockZone('z');
    session.unlockZone('z');
    const log = metrics.snapshot().eventLog;
    expect(log.map((e) => e.event.kind)).toEqual(['committed', 'zone-locked', 'zone-unlocked']);
    expect(log.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('完整生命周期：事件日志与原始事件流逐条 deep-equal', () => {
    const metrics = new SessionMetrics();
    const raw: SessionEvent[] = [];
    const session = new ProposalSession({
      onEvent: (event) => {
        metrics.onEvent(event);
        raw.push(event);
      },
    });
    session.stage('a', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.stage('a', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('a', { confirmed: true });
    session.stage('a', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    session.commit('a', { confirmed: true });
    session.revert('a');
    session.stage('a', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.abort('a');
    session.lockZone('a');
    session.unlockZone('a');
    const log = metrics.snapshot().eventLog;
    expect(log.map((e) => e.event)).toEqual(raw);
    expect(log.map((e) => e.seq)).toEqual(raw.map((_, i) => i + 1));
  });
});

describe('perf 采样（确定性 every-Nth，无随机）', () => {
  it('每第 N 次调用记录一个样本：min/max/mean 只覆盖被记录样本', () => {
    const metrics = new SessionMetrics({ perfSampleEvery: 3 });
    metrics.notePerfSample('gate.total', 10);
    metrics.notePerfSample('gate.total', 20);
    metrics.notePerfSample('gate.total', 30);
    metrics.notePerfSample('gate.total', 5);
    metrics.notePerfSample('gate.total', 100);
    let stat = metrics.snapshot().perf[0]!;
    expect(stat.samples).toBe(1);
    expect(stat.minMs).toBe(30);
    expect(stat.maxMs).toBe(30);
    expect(stat.meanMs).toBe(30);
    metrics.notePerfSample('gate.total', 50);
    stat = metrics.snapshot().perf[0]!;
    expect(stat.samples).toBe(2);
    expect(stat.minMs).toBe(30);
    expect(stat.maxMs).toBe(50);
    expect(stat.meanMs).toBe(40);
  });

  it('默认 every 10；多次快照采样统计只增不减', () => {
    const metrics = new SessionMetrics();
    for (let i = 1; i <= 25; i += 1) {
      metrics.notePerfSample('session.stage', i);
    }
    const first = metrics.snapshot().perf[0]!;
    expect(first.samples).toBe(2);
    expect(first.meanMs).toBe(15);
    expect(metrics.snapshot().perf[0]!.samples).toBe(first.samples);
  });

  it('label 校验与 ms 校验 → RangeError', () => {
    const metrics = new SessionMetrics();
    expect(() => metrics.notePerfSample('', 1)).toThrow(RangeError);
    expect(() => metrics.notePerfSample('x', -1)).toThrow(RangeError);
    expect(() => metrics.notePerfSample('x', Number.NaN)).toThrow(RangeError);
    expect(() => metrics.notePerfSample('x', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(metrics.snapshot().perf).toEqual([]);
  });

  it('多 label 相互独立；快照按 label 字典序', () => {
    const metrics = new SessionMetrics({ perfSampleEvery: 1 });
    metrics.notePerfSample('host.render', 5);
    metrics.notePerfSample('gate.total', 7);
    metrics.notePerfSample('host.render', 9);
    expect(metrics.snapshot().perf.map((p) => p.label)).toEqual(['gate.total', 'host.render']);
    expect(metrics.snapshot().perf[0]!.meanMs).toBe(7);
    expect(metrics.snapshot().perf[1]!.maxMs).toBe(9);
  });
});

describe('zone 校验与快照形状', () => {
  it("zone '*' 保留给全局聚合：事件流与 noteUserEdit 均拒绝；失败不残留 zone 状态", () => {
    const metrics = new SessionMetrics();
    expect(() => metrics.onEvent({ kind: 'zone-unlocked', zone: '*' })).toThrow(RangeError);
    expect(() => metrics.noteUserEdit('*')).toThrow(RangeError);
    expect(() => metrics.noteUserEdit('')).toThrow(RangeError);
    expect(metrics.snapshot().zones).toEqual([]);
  });

  it('noteUserEdit 无 pending（竞态/宿主缺序）：仍计 zone 级编辑与交互，不归属任何提案', () => {
    const metrics = new SessionMetrics();
    metrics.noteUserEdit('z');
    metrics.onEvent({ kind: 'zone-locked', zone: 'z', abortedStagedId: null });
    const report = zoneReport(metrics.snapshot(), 'z');
    expect(report.counts.edits).toBe(1);
    expect(report.counts.proposals).toBe(0);
    expect(report.everInteracted).toBe(true);
    expect(report.pendingProposalId).toBeNull();
    expect(report.counts.activeLock).toBe(1);
    expect(report.health.engagementGate).toBe('insufficient-data');
  });

  it('zones 按字典序；global 标签为 "*"；快照幂等（两次 snapshot deep-equal）', () => {
    const metrics = new SessionMetrics();
    for (const zone of ['b', 'a', 'c']) metrics.noteUserEdit(zone);
    const snapshot = metrics.snapshot();
    expect(snapshot.zones.map((r) => r.zone)).toEqual(['a', 'b', 'c']);
    expect(snapshot.global.zone).toBe(GLOBAL_ZONE);
    expectGlobalSums(snapshot);
    expect(metrics.snapshot()).toEqual(snapshot);
  });
});

/* ---------------- 性质测试（确定性 + 不变量，v2 §11 验收） ---------------- */

interface Op {
  kind: 'stage' | 'commit' | 'abort' | 'revert' | 'lock' | 'unlock' | 'edit' | 'perf';
  zone: 'a' | 'b' | 'c';
  verdict: VerdictAction;
  pref: ConfirmationPolicy | undefined;
  agent: ConfirmationPolicy | undefined;
  confirmed: boolean;
  steps: number;
  label: string;
  ms: number;
  treeIdx: number;
}

const opArbitrary: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom('stage', 'commit', 'abort', 'revert', 'lock', 'unlock', 'edit', 'perf'),
  zone: fc.constantFrom('a', 'b', 'c'),
  verdict: fc.constantFrom('pass', 'transform', 'requireApproval', 'block'),
  pref: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
  agent: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
  confirmed: fc.boolean(),
  steps: fc.constantFrom(1, 2),
  label: fc.constantFrom('gate.total', 'session.stage', 'host.render'),
  ms: fc.double({ min: 0, max: 1000, noNaN: true }),
  treeIdx: fc.nat({ max: 2 }),
});

function execOp(stack: { session: ProposalSession; metrics: SessionMetrics }, op: Op): void {
  switch (op.kind) {
    case 'stage':
      stack.session.stage(op.zone, mkGate(TREES[op.treeIdx]!, op.verdict), {
        userPreference: op.pref,
        agentRequest: op.agent,
      });
      return;
    case 'commit':
      stack.session.commit(op.zone, { confirmed: op.confirmed });
      return;
    case 'abort':
      stack.session.abort(op.zone);
      return;
    case 'revert':
      stack.session.revert(op.zone, op.steps);
      return;
    case 'lock':
      stack.session.lockZone(op.zone);
      return;
    case 'unlock':
      stack.session.unlockZone(op.zone);
      return;
    case 'edit':
      stack.metrics.noteUserEdit(op.zone);
      return;
    case 'perf':
      stack.metrics.notePerfSample(op.label, op.ms);
      return;
  }
}

/** 不变量检查：任意事件流下计数关系、比率公式与 Go/No-Go 口径必须自洽 */
function checkInvariants(snapshot: MetricsSnapshot, maxEventLog: number): void {
  const reports = [...snapshot.zones, snapshot.global];
  for (const report of reports) {
    const c = report.counts;
    expect(c.committed).toBeLessThanOrEqual(c.proposals);
    expect(c.rollback).toBeLessThanOrEqual(c.committed);
    expect(c.transformedCommitted).toBeLessThanOrEqual(c.committed);
    const classified = c.acceptAsIs + c.acceptAfterEdit + c.autoApplied + c.ignore + c.abandonedAfterEdit;
    expect(classified).toBeLessThanOrEqual(c.proposals);
    // gateBlockRate = deniedBlocked/committed 无上界 1（blocked 不进 proposals 分母），
    // 其余比率均被各自分母约束在 [0,1]
    for (const rate of [
      report.rates.interactionRate,
      report.rates.directAcceptRate,
      report.rates.rollbackRate,
      report.rates.dormantShare,
      report.rates.autoFixRate,
    ]) {
      if (rate !== null) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    }
    if (report.rates.gateBlockRate !== null) {
      expect(report.rates.gateBlockRate).toBeGreaterThanOrEqual(0);
    }
    const interacting = c.acceptAsIs + c.acceptAfterEdit + c.rollback;
    if (c.proposals === 0) {
      expect(report.rates.interactionRate).toBeNull();
      expect(report.health.engagementGate).toBe('insufficient-data');
      expect(report.health.falseGreenRisk).toBe(false);
    } else {
      expect(report.rates.interactionRate).toBeCloseTo(interacting / c.proposals, 12);
      expect(report.health.engagementGate).toBe(report.rates.interactionRate! >= 0.3 ? 'pass' : 'fail');
    }
    if (interacting > 0) {
      expect(report.rates.directAcceptRate).toBeCloseTo(c.acceptAsIs / interacting, 12);
    } else {
      expect(report.rates.directAcceptRate).toBeNull();
    }
    if (c.committed > 0) {
      expect(report.rates.rollbackRate).toBeCloseTo(c.rollback / c.committed, 12);
      expect(report.rates.gateBlockRate).toBeCloseTo(c.deniedBlocked / c.committed, 12);
      expect(report.rates.autoFixRate).toBeCloseTo(c.transformedCommitted / c.committed, 12);
    } else {
      expect(report.rates.rollbackRate).toBeNull();
      expect(report.rates.gateBlockRate).toBeNull();
      expect(report.rates.autoFixRate).toBeNull();
    }
    if (report.health.falseGreenRisk) {
      expect(report.health.engagementGate).toBe('fail');
      expect(report.rates.rollbackRate).not.toBeNull();
      expect(report.rates.rollbackRate!).toBeLessThan(0.2);
    }
    if (report.everInteracted) {
      expect(c.edits + c.acceptAsIs + c.acceptAfterEdit + c.rollback).toBeGreaterThan(0);
    }
  }
  expectGlobalSums(snapshot);
  expect(snapshot.global.pendingProposalId).toBeNull();
  expect(snapshot.eventLog.length).toBeLessThanOrEqual(maxEventLog);
  for (let i = 1; i < snapshot.eventLog.length; i += 1) {
    expect(snapshot.eventLog[i]!.seq).toBe(snapshot.eventLog[i - 1]!.seq + 1);
  }
}

describe('性质：确定性与不变量（≥200 runs）', () => {
  it('确定性：同一操作序列两套独立 (session+metrics) 栈的快照 deep-equal，且 snapshot 幂等', () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 10, maxLength: 40 }), (ops) => {
        const a = wired();
        const b = wired();
        for (const op of ops) {
          execOp(a, op);
          execOp(b, op);
        }
        const snapshot = a.metrics.snapshot();
        expect(a.metrics.snapshot()).toEqual(snapshot);
        expect(b.metrics.snapshot()).toEqual(snapshot);
      }),
      { numRuns: 200 },
    );
  }, 30000);

  it('不变量：随机事件流下计数关系/比率公式/Go-No-Go 口径/日志界全部自洽', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 4 }).map((n) => n + 1),
        fc.array(opArbitrary, { minLength: 10, maxLength: 40 }),
        (maxEventLog, ops) => {
          const stack = wired({ maxEventLog });
          for (const op of ops) execOp(stack, op);
          checkInvariants(stack.metrics.snapshot(), maxEventLog);
        },
      ),
      { numRuns: 200 },
    );
  }, 30000);
});
