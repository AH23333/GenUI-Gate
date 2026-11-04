import type { GateResult } from '@genui/gate';
import type { VerdictAction } from '@genui/gate';
import { specHash } from '@genui/ir';
import type { IRNode, JsonObject } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ArbitrationRequest, ConfirmationPolicy } from '../src/arbitration';
import { ProposalSession } from '../src/proposal';
import type {
  AbortResult,
  AbortToken,
  CommitResult,
  CommittedProposal,
  RevertResult,
  SessionEvent,
  StageResult,
  StagedProposal,
} from '../src/types';

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

class SpyToken implements AbortToken {
  abortedCount = 0;
  abort(): void {
    this.abortedCount += 1;
  }
}

/** 收集事件并保留插入序（onEvent 在状态落定后回调） */
function newSession(ringSize?: number): { session: ProposalSession; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const session = new ProposalSession({
    ...(ringSize === undefined ? {} : { ringSize }),
    onEvent: (event) => events.push(event),
  });
  return { session, events };
}

describe('constructor', () => {
  it('accepts positive integer ringSize and defaults to 20', () => {
    expect(() => new ProposalSession()).not.toThrow();
    expect(() => new ProposalSession({ ringSize: 1 })).not.toThrow();
  });

  it('rejects non-positive, fractional, NaN ringSize', () => {
    expect(() => new ProposalSession({ ringSize: 0 })).toThrow(RangeError);
    expect(() => new ProposalSession({ ringSize: -1 })).toThrow(RangeError);
    expect(() => new ProposalSession({ ringSize: 1.5 })).toThrow(RangeError);
    expect(() => new ProposalSession({ ringSize: Number.NaN })).toThrow(RangeError);
  });
});

describe('stage (v2 §9.1/§9.2)', () => {
  it('first stage: deterministic id p1, diff vs null, default arbitration user-confirm', () => {
    const { session, events } = newSession();
    const result = session.stage('sidebar', mkGate(T1, 'pass'), {});
    expect(result.status).toBe('staged');
    expect(result.abortedPreviousId).toBeNull();
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.id).toBe('p1');
    expect(result.proposal!.seq).toBe(1);
    expect(result.proposal!.zone).toBe('sidebar');
    expect(result.proposal!.verdict).toBe('pass');
    expect(result.proposal!.confirmation).toBe('user-confirm');
    expect(result.proposal!.arbitration.decidedBy).toBe('default');
    expect(result.proposal!.irPrime).toBe(T1);
    expect(result.proposal!.irPrimeHash).toBe(specHash(T1));
    expect(result.proposal!.diff.added).toContain('<root>');
    expect(result.proposal!.diff.removed).toEqual([]);
    expect(session.getStaged('sidebar')?.id).toBe('p1');
    expect(events.map((e) => e.kind)).toEqual(['staged']);
  });

  it('trace = gate trace (原序) + arbitration trace entries（固定求值序进 trace）', () => {
    const { session } = newSession();
    const gateEntry: GateResult['trace'][number] = {
      ruleId: 'whitelist.text',
      severity: 'info',
      action: 'pass',
      nodePath: '<root>',
      message: 'surface "Text" whitelisted',
    };
    const result = session.stage('z', mkGate(T1, 'transform', [gateEntry]), { agentRequest: 'never' });
    const trace = result.proposal!.trace;
    expect(trace[0]).toBe(gateEntry);
    expect(trace[1]).toMatchObject({ ruleId: 'arbitration.user-lock' });
    expect(trace[2]).toMatchObject({ ruleId: 'arbitration.user-preference' });
    expect(trace[3]).toMatchObject({ ruleId: 'arbitration.platform-policy' });
    expect(trace[4]).toMatchObject({ ruleId: 'arbitration.agent-proposal', action: 'pass' });
    expect(trace[4]!.message).toContain('"z"');
    expect(trace).toHaveLength(5);
  });

  it('gate block verdict → denied-blocked, nothing staged, seq not consumed', () => {
    const { session, events } = newSession();
    const denied = session.stage('z', mkGate(T1, 'block'), {});
    expect(denied.status).toBe('denied-blocked');
    expect(denied.proposal).toBeNull();
    expect(session.getStaged('z')).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['stage-denied']);
    const next = session.stage('z', mkGate(T1, 'pass'), {});
    expect(next.proposal!.id).toBe('p1');
  });

  it('zone locked → denied-user-lock（优先于 gate block）', () => {
    const { session, events } = newSession();
    session.lockZone('z');
    const denied = session.stage('z', mkGate(T1, 'block'), {});
    expect(denied.status).toBe('denied-user-lock');
    expect(denied.arbitration.allowed).toBe(false);
    expect(session.getStaged('z')).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['zone-locked', 'stage-denied']);
  });

  it('hostile request.userLock is ignored: session lock state is authoritative', () => {
    const { session } = newSession();
    session.lockZone('z');
    const hostile: ArbitrationRequest = { agentRequest: 'never' };
    Object.assign(hostile, { userLock: false });
    expect(session.stage('z', mkGate(T1, 'pass'), hostile).status).toBe('denied-user-lock');
  });

  it('同一 zone 至多一个 staged：新 stage 使旧 staged aborted（superseded-by-newer）', () => {
    const { session, events } = newSession();
    const first = session.stage('z', mkGate(T1, 'pass'), {});
    const second = session.stage('z', mkGate(T2, 'pass'), {});
    expect(second.abortedPreviousId).toBe(first.proposal!.id);
    expect(session.getStaged('z')?.id).toBe(second.proposal!.id);
    expect(events.map((e) => e.kind)).toEqual(['staged', 'staged-aborted', 'staged']);
    expect(events[1]).toMatchObject({ reason: 'superseded-by-newer', proposalId: first.proposal!.id });
  });

  it('跨 zone 独立，seq 全局单调', () => {
    const { session } = newSession();
    const a = session.stage('a', mkGate(T1, 'pass'), {});
    const b = session.stage('b', mkGate(T2, 'pass'), {});
    expect(a.proposal!.id).toBe('p1');
    expect(b.proposal!.id).toBe('p2');
    expect(session.getStaged('a')?.id).toBe('p1');
    expect(session.getStaged('b')?.id).toBe('p2');
  });

  it('diff 基线 = stage 时的 applied 状态；仲裁请求透传（userPreference 优先于 agentRequest）', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), {});
    session.commit('z', { confirmed: true });
    const second = session.stage('z', mkGate(T2, 'pass'), { userPreference: 'auto', agentRequest: 'never' });
    expect(second.proposal!.confirmation).toBe('auto');
    expect(second.proposal!.arbitration.decidedBy).toBe('user-preference');
    expect(second.proposal!.diff.changed).toContain('<root>');
    expect(second.proposal!.diff.added).toEqual([]);
  });
});

describe('commit (v2 §9.1 两阶段提交)', () => {
  it('no staged → no-staged', () => {
    const { session } = newSession();
    expect(session.commit('z')).toEqual({ status: 'no-staged', proposal: null, supersededId: null });
  });

  it('fail-closed：默认 user-confirm 且未 confirmed → confirmation-required，staged 保留', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), {});
    const refused = session.commit('z', {});
    expect(refused.status).toBe('confirmation-required');
    expect(session.getStaged('z')).not.toBeNull();
    const committed = session.commit('z', { confirmed: true });
    expect(committed.status).toBe('committed');
  });

  it('confirmation never/auto + verdict pass → 直接放行，无需 confirmed', () => {
    const { session: s1 } = newSession();
    s1.stage('z', mkGate(T1, 'pass'), { agentRequest: 'never' });
    expect(s1.commit('z', {}).status).toBe('committed');
    const { session: s2 } = newSession();
    s2.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    expect(s2.commit('z', {}).status).toBe('committed');
  });

  it('gate verdict requireApproval 时无论仲裁策略如何都必须 confirmed（gate 把门优先）', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'requireApproval'), { agentRequest: 'never' });
    expect(session.commit('z', {}).status).toBe('confirmation-required');
    expect(session.commit('z', { confirmed: true }).status).toBe('committed');
  });

  it('committed 与 staged 消费同一个 IR′ 对象（v2 §9.1 判定标准）', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    const staged = session.getStaged('z');
    const committed = session.commit('z', { focusHint: 'input-42' });
    expect(committed.proposal!.irPrime).toBe(staged!.irPrime);
    expect(committed.proposal!.irPrimeHash).toBe(specHash(committed.proposal!.irPrime));
    expect(committed.proposal!.focusHint).toBe('input-42');
    expect(session.getStaged('z')).toBeNull();
    expect(session.commit('z', {}).status).toBe('no-staged');
  });

  it('supersededId 链：首个 commit 为 null，后续指向前一 applied', () => {
    const { session, events } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    const c1 = session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const c2 = session.commit('z', {});
    expect(c1.supersededId).toBeNull();
    expect(c2.supersededId).toBe(c1.proposal!.id);
    expect(c2.proposal!.committedSeq).toBeGreaterThan(c2.proposal!.seq);
    expect(session.getApplied('z')?.id).toBe(c2.proposal!.id);
    expect(events.at(-1)).toMatchObject({ kind: 'committed', proposalId: c2.proposal!.id });
  });
});

describe('abort', () => {
  it('no staged → no-staged', () => {
    const { session } = newSession();
    expect(session.abort('z')).toEqual({ status: 'no-staged', abortedId: null });
  });

  it('abort staged → aborted，事件 reason user-abort', () => {
    const { session, events } = newSession();
    const staged = session.stage('z', mkGate(T1, 'pass'), {});
    const aborted = session.abort('z');
    expect(aborted).toEqual({ status: 'aborted', abortedId: staged.proposal!.id });
    expect(session.getStaged('z')).toBeNull();
    expect(events.at(-1)).toMatchObject({ kind: 'staged-aborted', reason: 'user-abort' });
  });
});

describe('revert (v2 §10 回滚)', () => {
  it('无快照 → no-snapshot + revert-failed 事件', () => {
    const { session, events } = newSession();
    const result = session.revert('z');
    expect(result.status).toBe('no-snapshot');
    expect(result.snapshot).toBeNull();
    expect(result.cancelledInflight).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(['revert-failed']);
  });

  it('steps 非法 → RangeError；越界 → no-snapshot', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    expect(() => session.revert('z', 0)).toThrow(RangeError);
    expect(() => session.revert('z', -1)).toThrow(RangeError);
    expect(() => session.revert('z', 1.5)).toThrow(RangeError);
    expect(session.revert('z', 5).status).toBe('no-snapshot');
    // 单次提交后无可回滚快照（首个 commit 之前无状态）
    expect(session.revert('z', 1).status).toBe('no-snapshot');
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    expect(session.revert('z', 1).status).toBe('reverted');
  });

  it('恢复到快照：snapshot 与原 committed 同一对象，applied/cursor 正确迁移', () => {
    const { session, events } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    const c1 = session.commit('z', { focusHint: 'input-1' });
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const c2 = session.commit('z', { focusHint: 'input-2' });
    expect(session.getRevertDepth('z')).toBe(1);
    const result = session.revert('z');
    expect(result.status).toBe('reverted');
    expect(result.snapshot).toBe(c1.proposal);
    expect(result.snapshot!.focusHint).toBe('input-1');
    expect(result.revertedProposalId).toBe(c2.proposal!.id);
    expect(session.getApplied('z')?.id).toBe(c1.proposal!.id);
    expect(session.getRevertDepth('z')).toBe(0);
    expect(events.at(-1)).toMatchObject({
      kind: 'reverted',
      restoredProposalId: c1.proposal!.id,
      revertedProposalId: c2.proposal!.id,
      cancelledInflight: 0,
    });
    expect(session.revert('z').status).toBe('no-snapshot');
  });

  it('staged 不受 revert 影响（IR′ 是绝对态，diff 过期由宿主重算）', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    const staged = session.getStaged('z');
    const diffBefore = staged!.diff;
    session.revert('z');
    expect(session.getStaged('z')).toBe(staged);
    expect(session.getStaged('z')!.diff).toEqual(diffBefore);
  });

  it('commit-after-revert 截断重做尾巴：回滚后新 commit 使分叉历史不可达', () => {
    const { session } = newSession();
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    const c1 = session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.revert('z');
    session.stage('z', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    expect(session.getRevertDepth('z')).toBe(1);
    const retry = session.revert('z');
    expect(retry.status).toBe('reverted');
    expect(retry.snapshot).toBe(c1.proposal);
    // 被截断的 p2 不可达
    expect(session.revert('z').status).toBe('no-snapshot');
  });

  it('取消已注册 inflight（回滚执行序第 1 步），commit 不取消', () => {
    const { session } = newSession();
    const t1 = new SpyToken();
    const t2 = new SpyToken();
    session.registerInflight('z', t1);
    session.stage('z', mkGate(T1, 'pass'), { agentRequest: 'auto' });
    session.registerInflight('z', t2);
    const committed = session.commit('z', {});
    expect(committed.proposal!.inflightCount).toBe(2);
    expect(t1.abortedCount).toBe(0);
    expect(t2.abortedCount).toBe(0);
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    const result = session.revert('z');
    expect(result.cancelledInflight).toBe(2);
    expect(t1.abortedCount).toBe(1);
    expect(t2.abortedCount).toBe(1);
    expect(session.revert('z').cancelledInflight).toBe(0);
  });

  it('registerInflight 校验 token.abort 必须是函数', () => {
    const { session } = newSession();
    const bad: AbortToken = { abort: () => {} };
    Object.assign(bad, { abort: 'not-a-function' });
    expect(() => session.registerInflight('z', bad)).toThrow(RangeError);
  });

  it('环形逐出：ringSize=2 时第 3 次 commit 逐出最旧快照（snapshot-evicted）', () => {
    const { session, events } = newSession(2);
    for (const tree of [T1, T2, T3]) {
      session.stage('z', mkGate(tree, 'pass'), { agentRequest: 'auto' });
      session.commit('z', {});
    }
    expect(events.filter((e) => e.kind === 'snapshot-evicted')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'snapshot-evicted')).toMatchObject({ proposalId: 'p1' });
    expect(session.getRevertDepth('z')).toBe(1);
    expect(session.revert('z').status).toBe('reverted');
    expect(session.revert('z').status).toBe('no-snapshot');
  });

  it('防投毒：目标快照 irPrimeHash 不匹配 → snapshot-corrupted，该条移出环形', () => {
    const poisonTree = node('poison', 'Column', { v: 1 });
    const { session, events } = newSession();
    session.stage('z', mkGate(poisonTree, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const c2 = session.commit('z', {});
    // 篡改回滚目标（ring[0]）的 IR′ 内容
    poisonTree.props.v = 999;
    const result = session.revert('z');
    expect(result.status).toBe('snapshot-corrupted');
    expect(result.snapshot).toBeNull();
    expect(result.cancelledInflight).toBe(0);
    // 污染条目已移出环形：applied 保持不变，深度随之回退
    expect(session.getApplied('z')).toBe(c2.proposal);
    expect(session.getRevertDepth('z')).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'revert-failed', reason: 'snapshot-corrupted' });
    // 逐出后状态机继续可用
    session.stage('z', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    expect(session.commit('z', {}).status).toBe('committed');
  });

  it('防投毒（深层）：目标快照被污染时丢弃该条，applied 保持不变', () => {
    const poisonTree = node('p0', 'Stack', { v: 0 });
    const { session } = newSession(3);
    session.stage('z', mkGate(poisonTree, 'pass'), { agentRequest: 'auto' });
    session.commit('z', {});
    session.stage('z', mkGate(T2, 'pass'), { agentRequest: 'auto' });
    const c2 = session.commit('z', {});
    session.stage('z', mkGate(T3, 'pass'), { agentRequest: 'auto' });
    const c3 = session.commit('z', {});
    poisonTree.props.v = 424242;
    const result = session.revert('z', 2);
    expect(result.status).toBe('snapshot-corrupted');
    expect(session.getApplied('z')?.id).toBe(c3.proposal!.id);
    expect(session.getRevertDepth('z')).toBe(1);
    const retry = session.revert('z', 1);
    expect(retry.status).toBe('reverted');
    expect(retry.snapshot).toBe(c2.proposal);
  });
});

describe('lockZone / unlockZone', () => {
  it('lock 使 staged aborted（reason zone-locked），幂等且不影响其他 zone', () => {
    const { session, events } = newSession();
    session.stage('a', mkGate(T1, 'pass'), {});
    session.stage('b', mkGate(T2, 'pass'), {});
    session.lockZone('a');
    expect(session.getStaged('a')).toBeNull();
    expect(session.getStaged('b')).not.toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['staged', 'staged', 'staged-aborted', 'zone-locked']);
    expect(events.at(-1)).toMatchObject({ kind: 'zone-locked', zone: 'a', abortedStagedId: 'p1' });
    session.lockZone('a');
    expect(events.filter((e) => e.kind === 'zone-locked')).toHaveLength(1);
  });

  it('lock 后 stage 拒绝，unlock 后恢复，unlock 幂等', () => {
    const { session, events } = newSession();
    session.lockZone('z');
    expect(session.isZoneLocked('z')).toBe(true);
    expect(session.stage('z', mkGate(T1, 'pass'), {}).status).toBe('denied-user-lock');
    session.unlockZone('z');
    session.unlockZone('z');
    expect(session.isZoneLocked('z')).toBe(false);
    expect(session.stage('z', mkGate(T1, 'pass'), {}).status).toBe('staged');
    expect(events.filter((e) => e.kind === 'zone-unlocked')).toHaveLength(1);
  });
});

describe('zone 参数校验与 getZones', () => {
  it('空 zone 名 → RangeError（全部公共方法）', () => {
    const { session } = newSession();
    expect(() => session.stage('', mkGate(T1, 'pass'), {})).toThrow(RangeError);
    expect(() => session.commit('')).toThrow(RangeError);
    expect(() => session.abort('')).toThrow(RangeError);
    expect(() => session.revert('')).toThrow(RangeError);
    expect(() => session.getStaged('')).toThrow(RangeError);
    expect(() => session.getApplied('')).toThrow(RangeError);
    expect(() => session.getRevertDepth('')).toThrow(RangeError);
    expect(() => session.isZoneLocked('')).toThrow(RangeError);
    expect(() => session.lockZone('')).toThrow(RangeError);
    expect(() => session.unlockZone('')).toThrow(RangeError);
    expect(() => session.registerInflight('', new SpyToken())).toThrow(RangeError);
  });

  it('getZones 按字典序', () => {
    const { session } = newSession();
    session.stage('b', mkGate(T1, 'pass'), {});
    session.stage('a', mkGate(T2, 'pass'), {});
    session.stage('c', mkGate(T3, 'pass'), {});
    expect(session.getZones()).toEqual(['a', 'b', 'c']);
  });
});

describe('事件生命周期（全序）', () => {
  it('stage → supersede → commit ×2 → revert → abort → lock → unlock', () => {
    const { session, events } = newSession();
    session.stage('a', mkGate(T1, 'pass'), {});
    session.stage('a', mkGate(T2, 'pass'), {});
    session.commit('a', { confirmed: true });
    session.stage('a', mkGate(T3, 'pass'), {});
    session.commit('a', { confirmed: true });
    session.revert('a');
    session.stage('a', mkGate(T1, 'pass'), {});
    session.abort('a');
    session.lockZone('a');
    session.unlockZone('a');
    expect(events.map((e) => e.kind)).toEqual([
      'staged',
      'staged-aborted',
      'staged',
      'committed',
      'staged',
      'committed',
      'reverted',
      'staged',
      'staged-aborted',
      'zone-locked',
      'zone-unlocked',
    ]);
  });
});

/* ---------------- 性质测试：模型对拍（v2 §9.1/§10 验收） ---------------- */

interface ModelZone {
  locked: boolean;
  stagedId: string | null;
  stagedVerdict: VerdictAction;
  stagedConfirmation: ConfirmationPolicy;
  ring: string[];
  cursor: number;
  inflight: number;
}

/** 规格级影子模型：以 id/计数独立实现 §9.1 状态机 + §10 环形快照语义 */
class ModelSession {
  readonly zones = new Map<string, ModelZone>();
  nextSeq = 1;
  readonly events: string[] = [];

  constructor(readonly ringSize: number) {}

  zone(zone: string): ModelZone {
    let z = this.zones.get(zone);
    if (z === undefined) {
      z = {
        locked: false,
        stagedId: null,
        stagedVerdict: 'pass',
        stagedConfirmation: 'user-confirm',
        ring: [],
        cursor: -1,
        inflight: 0,
      };
      this.zones.set(zone, z);
    }
    return z;
  }

  stage(
    zone: string,
    verdict: VerdictAction,
    request: ArbitrationRequest,
  ): { status: StageResult['status']; id: string | null; abortedPreviousId: string | null; confirmation: ConfirmationPolicy } {
    const z = this.zone(zone);
    if (z.locked) {
      this.events.push(`stage-denied:${zone}`);
      return { status: 'denied-user-lock', id: null, abortedPreviousId: null, confirmation: 'user-confirm' };
    }
    const confirmation: ConfirmationPolicy =
      request.userPreference ?? request.platformPolicy ?? request.agentRequest ?? 'user-confirm';
    if (verdict === 'block') {
      this.events.push(`stage-denied:${zone}`);
      return { status: 'denied-blocked', id: null, abortedPreviousId: null, confirmation };
    }
    const abortedPreviousId = z.stagedId;
    if (z.stagedId !== null) this.events.push(`staged-aborted:${zone}`);
    const id = `p${this.nextSeq}`;
    this.nextSeq += 1;
    z.stagedId = id;
    z.stagedVerdict = verdict;
    z.stagedConfirmation = confirmation;
    this.events.push(`staged:${zone}`);
    return { status: 'staged', id, abortedPreviousId, confirmation };
  }

  commit(
    zone: string,
    confirmed: boolean | undefined,
    focus: string | undefined,
  ): { status: CommitResult['status']; id: string | null; committedSeq: number | null; supersededId: string | null; focus: string | null; inflightCount: number } {
    const z = this.zone(zone);
    if (z.stagedId === null) {
      return { status: 'no-staged', id: null, committedSeq: null, supersededId: null, focus: null, inflightCount: 0 };
    }
    const needsConfirmation = z.stagedVerdict === 'requireApproval' || z.stagedConfirmation === 'user-confirm';
    if (needsConfirmation && confirmed !== true) {
      return { status: 'confirmation-required', id: null, committedSeq: null, supersededId: null, focus: null, inflightCount: 0 };
    }
    const id = z.stagedId!;
    const previousApplied = z.cursor < 0 ? null : z.ring[z.cursor]!;
    const committedSeq = this.nextSeq;
    this.nextSeq += 1;
    z.ring.length = z.cursor + 1;
    z.ring.push(id);
    if (z.ring.length > this.ringSize) {
      z.ring.shift();
      this.events.push(`snapshot-evicted:${zone}`);
    }
    z.cursor = z.ring.length - 1;
    z.stagedId = null;
    this.events.push(`committed:${zone}`);
    return {
      status: 'committed',
      id,
      committedSeq,
      supersededId: previousApplied,
      focus: focus ?? null,
      inflightCount: z.inflight,
    };
  }

  abort(zone: string): { status: AbortResult['status']; id: string | null } {
    const z = this.zone(zone);
    if (z.stagedId === null) return { status: 'no-staged', id: null };
    const id = z.stagedId;
    z.stagedId = null;
    this.events.push(`staged-aborted:${zone}`);
    return { status: 'aborted', id };
  }

  revert(
    zone: string,
    steps: number,
  ): { status: RevertResult['status']; snapshotId: string | null; revertedId: string | null; cancelledInflight: number } {
    const z = this.zone(zone);
    const target = z.cursor - steps;
    if (target < 0) {
      this.events.push(`revert-failed:${zone}`);
      return { status: 'no-snapshot', snapshotId: null, revertedId: null, cancelledInflight: 0 };
    }
    const cancelled = z.inflight;
    z.inflight = 0;
    const revertedId = z.ring[z.cursor]!;
    z.cursor = target;
    this.events.push(`reverted:${zone}`);
    return { status: 'reverted', snapshotId: z.ring[target]!, revertedId, cancelledInflight: cancelled };
  }

  lock(zone: string): void {
    const z = this.zone(zone);
    if (z.locked) return;
    z.locked = true;
    if (z.stagedId !== null) {
      this.events.push(`staged-aborted:${zone}`);
      z.stagedId = null;
    }
    this.events.push(`zone-locked:${zone}`);
  }

  unlock(zone: string): void {
    const z = this.zone(zone);
    if (!z.locked) return;
    z.locked = false;
    this.events.push(`zone-unlocked:${zone}`);
  }

  registerInflight(zone: string): void {
    this.zone(zone).inflight += 1;
  }

  stateOf(zone: string): { locked: boolean; stagedId: string | null; appliedId: string | null; depth: number } {
    const z = this.zone(zone);
    return {
      locked: z.locked,
      stagedId: z.stagedId,
      appliedId: z.cursor < 0 ? null : z.ring[z.cursor]!,
      depth: z.cursor < 0 ? 0 : z.cursor,
    };
  }

  zoneNames(): string[] {
    return [...this.zones.keys()].sort();
  }
}

interface Op {
  kind: 'stage' | 'commit' | 'abort' | 'revert' | 'lock' | 'unlock' | 'inflight';
  zone: 'a' | 'b';
  verdict: VerdictAction;
  pref: ConfirmationPolicy | undefined;
  agent: ConfirmationPolicy | undefined;
  confirmed: boolean;
  steps: number;
  focus: string | undefined;
  treeIdx: number;
}

const PROP_TREES: IRNode[] = [T1, T2, T3];

const opArbitrary: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom('stage', 'commit', 'abort', 'revert', 'lock', 'unlock', 'inflight'),
  zone: fc.constantFrom('a', 'b'),
  verdict: fc.constantFrom('pass', 'transform', 'requireApproval', 'block'),
  pref: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
  agent: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
  confirmed: fc.boolean(),
  steps: fc.constantFrom(1, 2),
  focus: fc.option(fc.string({ minLength: 0, maxLength: 4 }), { nil: undefined }),
  treeIdx: fc.nat({ max: 2 }),
});

const ZONES = ['a', 'b'] as const;

function execOp(session: ProposalSession, op: Op): void {
  switch (op.kind) {
    case 'stage':
      session.stage(op.zone, mkGate(PROP_TREES[op.treeIdx]!, op.verdict), {
        userPreference: op.pref,
        agentRequest: op.agent,
      });
      return;
    case 'commit':
      session.commit(op.zone, { confirmed: op.confirmed, focusHint: op.focus });
      return;
    case 'abort':
      session.abort(op.zone);
      return;
    case 'revert':
      session.revert(op.zone, op.steps);
      return;
    case 'lock':
      session.lockZone(op.zone);
      return;
    case 'unlock':
      session.unlockZone(op.zone);
      return;
    case 'inflight':
      session.registerInflight(op.zone, new SpyToken());
      return;
  }
}

describe('性质：模型对拍（≥200 runs）', () => {
  it('随机操作序列下与规格影子模型全等（状态/结果/事件序）', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 3 }).map((n) => n + 1),
        fc.array(opArbitrary, { minLength: 10, maxLength: 40 }),
        (ringSize, ops) => {
          const sutEvents: string[] = [];
          const session = new ProposalSession({
            ringSize,
            onEvent: (event) => sutEvents.push(`${event.kind}:${event.zone}`),
          });
          const model = new ModelSession(ringSize);
          for (const op of ops) {
            switch (op.kind) {
              case 'stage': {
                const request: ArbitrationRequest = { userPreference: op.pref, agentRequest: op.agent };
                const sut = session.stage(op.zone, mkGate(PROP_TREES[op.treeIdx]!, op.verdict), request);
                const mdl = model.stage(op.zone, op.verdict, request);
                expect(sut.status).toBe(mdl.status);
                expect(sut.proposal?.id ?? null).toBe(mdl.id);
                expect(sut.proposal?.confirmation ?? mdl.confirmation).toBe(mdl.confirmation);
                expect(sut.abortedPreviousId).toBe(mdl.abortedPreviousId);
                if (sut.proposal !== null) {
                  expect(sut.proposal.irPrime).toBe(PROP_TREES[op.treeIdx]!);
                  expect(sut.proposal.irPrimeHash).toBe(specHash(PROP_TREES[op.treeIdx]!));
                }
                break;
              }
              case 'commit': {
                const stagedBefore = session.getStaged(op.zone);
                const sut = session.commit(op.zone, { confirmed: op.confirmed, focusHint: op.focus });
                const mdl = model.commit(op.zone, op.confirmed, op.focus);
                expect(sut.status).toBe(mdl.status);
                expect(sut.proposal?.id ?? null).toBe(mdl.id);
                expect(sut.proposal?.committedSeq ?? null).toBe(mdl.committedSeq);
                expect(sut.supersededId).toBe(mdl.supersededId);
                expect(sut.proposal?.focusHint ?? null).toBe(mdl.focus);
                expect(sut.proposal?.inflightCount ?? mdl.inflightCount).toBe(mdl.inflightCount);
                if (sut.status === 'committed') {
                  // v2 §9.1 验收：预览与 commit 消费同一个 IR′
                  expect(sut.proposal!.irPrime).toBe(stagedBefore!.irPrime);
                  expect(sut.proposal!.committedSeq).toBeGreaterThan(sut.proposal!.seq);
                }
                break;
              }
              case 'abort': {
                const sut = session.abort(op.zone);
                const mdl = model.abort(op.zone);
                expect(sut.status).toBe(mdl.status);
                expect(sut.abortedId).toBe(mdl.id);
                break;
              }
              case 'revert': {
                const appliedBefore = session.getApplied(op.zone);
                const sut = session.revert(op.zone, op.steps);
                const mdl = model.revert(op.zone, op.steps);
                expect(sut.status).toBe(mdl.status);
                expect(sut.snapshot?.id ?? null).toBe(mdl.snapshotId);
                expect(sut.revertedProposalId).toBe(mdl.revertedId);
                expect(sut.cancelledInflight).toBe(mdl.cancelledInflight);
                if (sut.status === 'reverted') {
                  // applied ≡ ring[cursor]：revert 后 getApplied 即恢复的快照
                  expect(session.getApplied(op.zone)).toBe(sut.snapshot);
                  expect(sut.snapshot!.id).not.toBe(appliedBefore?.id);
                }
                break;
              }
              case 'lock':
                session.lockZone(op.zone);
                model.lock(op.zone);
                break;
              case 'unlock':
                session.unlockZone(op.zone);
                model.unlock(op.zone);
                break;
              case 'inflight':
                session.registerInflight(op.zone, new SpyToken());
                model.registerInflight(op.zone);
                break;
            }
            for (const zone of ZONES) {
              // v2 §9.1 验收：同 zone 至多一个 staged（单槽位 + 与模型一致）
              const state = model.stateOf(zone);
              expect(session.getStaged(zone)?.id ?? null).toBe(state.stagedId);
              expect(session.getApplied(zone)?.id ?? null).toBe(state.appliedId);
              expect(session.getRevertDepth(zone)).toBe(state.depth);
              expect(session.isZoneLocked(zone)).toBe(state.locked);
            }
            expect(session.getZones()).toEqual(model.zoneNames());
            expect(sutEvents).toEqual(model.events);
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 20000);

  it('确定性：同一操作序列两次运行的事件流与终态深度相等（200 runs）', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 3 }).map((n) => n + 1),
        fc.array(opArbitrary, { minLength: 5, maxLength: 25 }),
        (ringSize, ops) => {
          const eventsA: SessionEvent[] = [];
          const eventsB: SessionEvent[] = [];
          const a = new ProposalSession({ ringSize, onEvent: (e) => eventsA.push(e) });
          const b = new ProposalSession({ ringSize, onEvent: (e) => eventsB.push(e) });
          for (const op of ops) execOp(a, op);
          for (const op of ops) execOp(b, op);
          expect(eventsA).toEqual(eventsB);
          for (const zone of ZONES) {
            expect(b.getStaged(zone)?.id ?? null).toBe(a.getStaged(zone)?.id ?? null);
            expect(b.getApplied(zone)?.id ?? null).toBe(a.getApplied(zone)?.id ?? null);
            expect(b.getRevertDepth(zone)).toBe(a.getRevertDepth(zone));
            expect(b.isZoneLocked(zone)).toBe(a.isZoneLocked(zone));
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 20000);
});
