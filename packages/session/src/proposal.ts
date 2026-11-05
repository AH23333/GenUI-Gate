import type { GateResult, TraceEntry } from '@genui/gate';
import { specHash } from '@genui/ir';
import { arbitrate } from './arbitration';
import type { ArbitrationRequest, ArbitrationResult } from './arbitration';
import { diffTrees } from './diff';
import type {
  AbortResult,
  AbortToken,
  CommitOptions,
  CommitResult,
  CommittedProposal,
  ProposalSessionOptions,
  RevertResult,
  SessionEvent,
  StageResult,
  StagedProposal,
} from './types';

const DEFAULT_RING_SIZE = 20;

interface ZoneState {
  locked: boolean;
  staged: StagedProposal | null;
  ring: CommittedProposal[];
  /** ring 内当前 applied 快照的下标；无快照时为 -1（v2 §10：仅 commit 边界快照） */
  cursor: number;
  inflight: AbortToken[];
}

/** 仲裁轨迹 → gate TraceEntry（v2 §9.2「结果进 trace」：统一由 trace 渲染，禁 LLM 解释） */
function arbitrationTraceEntries(zone: string, arbitration: ArbitrationResult): TraceEntry[] {
  return arbitration.trace.map(
    (entry): TraceEntry => ({
      ruleId: `arbitration.${entry.level}`,
      severity: 'info',
      action: entry.outcome === 'deny' ? 'block' : 'pass',
      nodePath: '<root>',
      message: `zone "${zone}": ${entry.detail} [level=${entry.level} outcome=${entry.outcome}]`,
    }),
  );
}

function assertZone(zone: string): void {
  if (typeof zone !== 'string' || zone === '') {
    throw new RangeError('zone must be a non-empty string');
  }
}

/**
 * 提案状态机（v2 §9.1，单写者语义）：
 *
 * ```
 * proposal ──stage──► staged(preview) ──commit──► applied ──► superseded | reverted
 *                          │ abort
 *                          ▼
 *                       aborted（新提案到达 → 旧提案 aborted）
 * ```
 *
 * - 同一 zone 同时至多一个 staged（新 stage 使旧 staged aborted——写冲突在状态机层面消除）；
 * - 两阶段提交：stage 收 gate 结果生成 IR′ + diff，commit 落快照并应用；
 *   **预览与 commit 消费同一个 IR′ 对象**（本类不做任何再计算/再校验）；
 * - 快照仅 commit 边界、环形 N=20、带 irPrimeHash 防投毒（v2 §10）；
 * - commit 确认把门（fail-closed）：verdict requireApproval 或 confirmation
 *   user-confirm 时必须显式 confirmed: true；
 * - 确定性：全局单调 seq 计数（`p${seq}`），无时钟无随机；同一操作序列恒得同一状态。
 */
export class ProposalSession {
  private readonly ringSize: number;
  private readonly onEvent?: (event: SessionEvent) => void;
  private readonly zones = new Map<string, ZoneState>();
  private nextSeq = 1;

  constructor(options: ProposalSessionOptions = {}) {
    const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    if (!Number.isInteger(ringSize) || ringSize < 1) {
      throw new RangeError(`ringSize must be a positive integer, got ${ringSize}`);
    }
    this.ringSize = ringSize;
    this.onEvent = options.onEvent;
  }

  stage(zone: string, gateResult: GateResult, request: ArbitrationRequest = {}): StageResult {
    assertZone(zone);
    const state = this.zoneState(zone);
    // Session 锁状态后置展开 = 权威来源：宿主无法经 request 覆盖 lock（防御性，TS 类型已挡、JS 宿主也挡）
    const arbitration = arbitrate({ ...request, userLock: state.locked });

    if (!arbitration.allowed) {
      this.emit({ kind: 'stage-denied', zone, reason: 'user-lock', seq: this.nextSeq });
      return { status: 'denied-user-lock', proposal: null, abortedPreviousId: null, arbitration };
    }
    if (gateResult.verdict === 'block') {
      this.emit({ kind: 'stage-denied', zone, reason: 'blocked', seq: this.nextSeq });
      return { status: 'denied-blocked', proposal: null, abortedPreviousId: null, arbitration };
    }

    // 单写者：同 zone 至多一个 staged——新提案到达 → 旧提案 aborted（v2 §9.1）
    const abortedPreviousId = state.staged?.id ?? null;
    if (state.staged !== null) {
      this.emit({
        kind: 'staged-aborted',
        zone,
        proposalId: state.staged.id,
        reason: 'superseded-by-newer',
        seq: this.nextSeq,
      });
    }

    const seq = this.nextSeq;
    this.nextSeq += 1;
    const baseline = this.currentApplied(state)?.irPrime ?? null;
    const proposal: StagedProposal = {
      id: `p${seq}`,
      zone,
      seq,
      irPrime: gateResult.ir,
      irPrimeHash: specHash(gateResult.ir),
      verdict: gateResult.verdict,
      trace: [...gateResult.trace, ...arbitrationTraceEntries(zone, arbitration)],
      arbitration,
      confirmation: arbitration.confirmation,
      diff: diffTrees(baseline, gateResult.ir),
    };
    state.staged = proposal;
    this.emit({ kind: 'staged', zone, proposalId: proposal.id, seq, verdict: proposal.verdict });
    return { status: 'staged', proposal, abortedPreviousId, arbitration };
  }

  commit(zone: string, options: CommitOptions = {}): CommitResult {
    assertZone(zone);
    const state = this.zoneState(zone);
    const staged = state.staged;
    if (staged === null) {
      return { status: 'no-staged', proposal: null, supersededId: null };
    }
    // fail-closed 确认把门：gate 要求审批（requireApproval）或仲裁策略为 user-confirm 时，
    // 必须显式 confirmed: true（低风险 auto/never 直接放行）
    const needsConfirmation = staged.verdict === 'requireApproval' || staged.confirmation === 'user-confirm';
    if (needsConfirmation && options.confirmed !== true) {
      return { status: 'confirmation-required', proposal: null, supersededId: null };
    }

    const previous = this.currentApplied(state);
    const committedSeq = this.nextSeq;
    this.nextSeq += 1;
    const committed: CommittedProposal = {
      ...staged,
      committedSeq,
      focusHint: options.focusHint ?? null,
      inflightCount: state.inflight.length,
    };

    // 仅 commit 边界落快照：截断 cursor 之后的重做尾巴，追加，超容量逐出最旧（环形 N）
    state.ring.length = state.cursor + 1;
    state.ring.push(committed);
    if (state.ring.length > this.ringSize) {
      const evicted = state.ring.shift()!;
      this.emit({ kind: 'snapshot-evicted', zone, proposalId: evicted.id });
    }
    state.cursor = state.ring.length - 1;
    state.staged = null;

    const supersededId = previous?.id ?? null;
    this.emit({
      kind: 'committed',
      zone,
      proposalId: committed.id,
      committedSeq,
      supersededId,
      userConfirmed: options.confirmed === true,
    });
    return { status: 'committed', proposal: committed, supersededId };
  }

  abort(zone: string): AbortResult {
    assertZone(zone);
    const state = this.zoneState(zone);
    const staged = state.staged;
    if (staged === null) {
      return { status: 'no-staged', abortedId: null };
    }
    state.staged = null;
    this.emit({
      kind: 'staged-aborted',
      zone,
      proposalId: staged.id,
      reason: 'user-abort',
      seq: this.nextSeq,
    });
    return { status: 'aborted', abortedId: staged.id };
  }

  revert(zone: string, steps = 1): RevertResult {
    assertZone(zone);
    if (!Number.isInteger(steps) || steps < 1) {
      throw new RangeError(`steps must be a positive integer, got ${steps}`);
    }
    const state = this.zoneState(zone);
    const targetIndex = state.cursor - steps;
    if (targetIndex < 0) {
      this.emit({ kind: 'revert-failed', zone, reason: 'no-snapshot', steps });
      return { status: 'no-snapshot', snapshot: null, revertedProposalId: null, cancelledInflight: 0 };
    }
    const target = state.ring[targetIndex]!;

    // 防投毒（v2 §10）：恢复前校验 irPrimeHash，不匹配即丢弃该快照（本条移出环形）
    if (specHash(target.irPrime) !== target.irPrimeHash) {
      state.ring.splice(targetIndex, 1);
      state.cursor -= 1;
      this.emit({ kind: 'revert-failed', zone, reason: 'snapshot-corrupted', steps });
      return { status: 'snapshot-corrupted', snapshot: null, revertedProposalId: null, cancelledInflight: 0 };
    }

    // 回滚执行序（v2 §10）：取消 inflight → 恢复 IR′（焦点恢复 best-effort：focusHint 随快照返还，宿主执行）
    const cancelledInflight = this.cancelInflight(state);
    const reverted = state.ring[state.cursor]!;
    state.cursor = targetIndex;
    this.emit({
      kind: 'reverted',
      zone,
      restoredProposalId: target.id,
      revertedProposalId: reverted.id,
      steps,
      cancelledInflight,
    });
    return { status: 'reverted', snapshot: target, revertedProposalId: reverted.id, cancelledInflight };
  }

  lockZone(zone: string): void {
    assertZone(zone);
    const state = this.zoneState(zone);
    if (state.locked) return;
    state.locked = true;
    const abortedStagedId = state.staged?.id ?? null;
    if (state.staged !== null) {
      this.emit({
        kind: 'staged-aborted',
        zone,
        proposalId: state.staged.id,
        reason: 'zone-locked',
        seq: this.nextSeq,
      });
      state.staged = null;
    }
    this.emit({ kind: 'zone-locked', zone, abortedStagedId });
  }

  unlockZone(zone: string): void {
    assertZone(zone);
    const state = this.zoneState(zone);
    if (!state.locked) return;
    state.locked = false;
    this.emit({ kind: 'zone-unlocked', zone });
  }

  /** 注册进行中请求（v2 §10）：回滚即取消；未注册的存量请求不承诺取消 */
  registerInflight(zone: string, token: AbortToken): void {
    assertZone(zone);
    if (typeof token.abort !== 'function') {
      throw new RangeError('inflight token must expose an abort() function');
    }
    this.zoneState(zone).inflight.push(token);
  }

  getStaged(zone: string): StagedProposal | null {
    assertZone(zone);
    return this.zoneState(zone).staged;
  }

  getApplied(zone: string): CommittedProposal | null {
    assertZone(zone);
    return this.currentApplied(this.zoneState(zone));
  }

  /** 可回滚深度（cursor）：再深即 no-snapshot */
  getRevertDepth(zone: string): number {
    assertZone(zone);
    const cursor = this.zoneState(zone).cursor;
    return cursor < 0 ? 0 : cursor;
  }

  isZoneLocked(zone: string): boolean {
    assertZone(zone);
    return this.zoneState(zone).locked;
  }

  /** 全部 zone 名，按字典序（确定性） */
  getZones(): string[] {
    return [...this.zones.keys()].sort();
  }

  private zoneState(zone: string): ZoneState {
    let state = this.zones.get(zone);
    if (state === undefined) {
      state = { locked: false, staged: null, ring: [], cursor: -1, inflight: [] };
      this.zones.set(zone, state);
    }
    return state;
  }

  private currentApplied(state: ZoneState): CommittedProposal | null {
    return state.cursor < 0 ? null : state.ring[state.cursor]!;
  }

  private cancelInflight(state: ZoneState): number {
    const count = state.inflight.length;
    for (const token of state.inflight) token.abort();
    state.inflight.length = 0;
    return count;
  }

  private emit(event: SessionEvent): void {
    this.onEvent?.(event);
  }
}
