import { A2UISession } from '@genui/adapter-a2ui';
import type { A2UIMessage, A2UIMessageKind, AdapterResult } from '@genui/adapter-a2ui';
import { gate } from '@genui/gate';
import type { GateOptions, GateResult } from '@genui/gate';
import type { IRNode, JsonValue } from '@genui/ir';
import { PendingFrameQueue, ProposalSession, SessionMetrics } from '@genui/session';
import type {
  AbortResult,
  ArbitrationRequest,
  CommitResult,
  CommittedProposal,
  IngestResult,
  RevertResult,
  SessionMetricsOptions,
  StagedProposal,
} from '@genui/session';
import { RuleProposer } from './proposer';
import type { ProposerGoal, ProposerRule } from './types';

/** 拒绝原因（v2 §14 失败矩阵 gate / renderer / pending 帧行，与 gate-react 控制器口径一致） */
export type LoopDenyReason = 'blocked' | 'user-lock' | 'gate-error';

export interface LoopDeniedState {
  readonly reason: LoopDenyReason;
  readonly message: string;
}

/** 面向渲染/断言的不可变状态快照 */
export interface ClosedLoopState {
  readonly zone: string;
  readonly surfaceId: string;
  readonly applied: CommittedProposal | null;
  readonly staged: StagedProposal | null;
  readonly denied: LoopDeniedState | null;
  readonly locked: boolean;
  readonly queueFrames: number;
  readonly resyncRequired: boolean;
}

/** 已提交帧记录：adapter 重放源（committedSeq 单调，与 session ring 的 commit 一一对应） */
export interface CommittedFrameRecord {
  readonly committedSeq: number;
  readonly message: A2UIMessage;
}

export interface ClosedLoopOptions {
  readonly rules: readonly ProposerRule[];
  readonly surfaceId: string;
  /** 提案 zone（默认 'main'） */
  readonly zone?: string;
  readonly gateOptions?: GateOptions;
  /** 快照环形容量（v2 §10，默认 20） */
  readonly ringSize?: number;
  readonly metricsOptions?: SessionMetricsOptions;
  /** 仲裁请求（v2 §9.2），逐帧透传 session.stage */
  readonly arbitration?: ArbitrationRequest;
}

const MESSAGE_KINDS: ReadonlySet<string> = new Set<string>([
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 帧结构校验（fail-closed）：规则产出必须是一条合法 A2UI 消息 */
function asA2UIMessage(payload: JsonValue): A2UIMessage | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const kind: unknown = payload['kind'];
  const messagePayload: unknown = payload['payload'];
  if (typeof kind !== 'string' || !MESSAGE_KINDS.has(kind)) return null;
  if (typeof messagePayload !== 'object' || messagePayload === null || Array.isArray(messagePayload)) return null;
  return payload as unknown as A2UIMessage;
}

/**
 * 闭环测量装置（v2 §17-P0 出口③）：提议 → Gate → 预览 → 确认 → 应用 → 回滚，
 * 全程无人工兜底、无 LLM、无时钟无随机——同一操作序列恒得同一状态。
 *
 * ```
 * RuleProposer.propose(goal) ──帧──► PendingFrameQueue（TD-004/005 入口兜底）
 *        │                                │ processQueue
 *        │                     takeOldest ▼
 *        │   adapter 重放 committed ──► adapter.apply(帧) ──► surface IR ──► gate()
 *        │                                                              │
 *        │            ┌─────────────────────────────────────────────────┘
 *        │            ▼ stage（v2 §9.1/§9.2）
 *        │     staged（预览 = irPrime + diff）          denied（blocked / user-lock / gate-error）
 *        │      │ confirm(confirmed:true)                └─► adapter 回滚到基线（fail-closed）
 *        │      ▼
 *        │   applied（commit 边界快照）+ 帧记录进 committedFrames
 *        └─ revert / discard / lock：session 迁移 + adapter 重放（协议状态一并恢复）
 * ```
 *
 * adapter 一致性不变量（性质测试锁定）：任意操作后，
 * `adapter ≡ reset + replay(getCommittedFrames()) + (staged ? apply(getStagedFrame()) : nothing)`。
 * 新提案一律基于 applied 基线（不叠加未确认效果）；denied/discard 的协议状态经全量重放回滚。
 */
export class ClosedLoop {
  readonly metrics: SessionMetrics;

  private readonly proposer: RuleProposer;
  private readonly adapter = new A2UISession();
  private readonly session: ProposalSession;
  private readonly queue = new PendingFrameQueue();
  private readonly surfaceId: string;
  private readonly zone: string;
  private readonly gateOptions: GateOptions;
  private readonly arbitration?: ArbitrationRequest;
  private committedFrames: CommittedFrameRecord[] = [];
  private stagedFrame: A2UIMessage | null = null;
  private denied: LoopDeniedState | null = null;
  private lastIngest: IngestResult | null = null;

  constructor(options: ClosedLoopOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('options must be an object');
    }
    if (typeof options.surfaceId !== 'string' || options.surfaceId === '') {
      throw new RangeError('options.surfaceId must be a non-empty string');
    }
    const zone = options.zone ?? 'main';
    if (typeof zone !== 'string' || zone === '') {
      throw new RangeError('zone must be a non-empty string');
    }
    if (!Array.isArray(options.rules)) {
      throw new TypeError('options.rules must be an array of ProposerRule');
    }
    this.surfaceId = options.surfaceId;
    this.zone = zone;
    this.gateOptions = options.gateOptions ?? {};
    this.arbitration = options.arbitration;
    this.metrics = new SessionMetrics(options.metricsOptions ?? {});
    this.session = new ProposalSession({
      ...(options.ringSize !== undefined ? { ringSize: options.ringSize } : {}),
      onEvent: this.metrics.onEvent,
    });
    this.proposer = new RuleProposer(options.rules);
  }

  /** 规则 id 列表（注册序） */
  getRuleIds(): string[] {
    return this.proposer.getRuleIds();
  }

  /** 提议一帧：规则实例化 → 入队（TD-004/005 入口兜底）→ 帧边界 commit 流 → 状态快照 */
  propose(goal: ProposerGoal): ClosedLoopState {
    const frame = this.proposer.propose(goal);
    this.lastIngest = this.queue.ingest(frame);
    this.processQueue();
    return this.state();
  }

  /** 最近一次入队结果（dropped-invalid / dropped-oversized 对测量可见） */
  getLastIngestResult(): IngestResult | null {
    return this.lastIngest;
  }

  /** 人工确认（Apply）：commit(confirmed: true) → 指标记 userConfirmed（KAN-026 口径） */
  confirm(): CommitResult {
    const staged = this.session.getStaged(this.zone);
    if (staged !== null && this.stagedFrame === null) {
      throw new Error('internal invariant violation: staged proposal without a source frame');
    }
    const result = this.session.commit(this.zone, { confirmed: true });
    if (result.status === 'committed' && result.proposal !== null) {
      this.committedFrames.push({
        committedSeq: result.proposal.committedSeq,
        message: this.stagedFrame!,
      });
      this.stagedFrame = null;
    }
    return result;
  }

  /** 人工拒绝（Discard）：abort + adapter 回滚到 applied 基线 */
  discard(): AbortResult {
    const result = this.session.abort(this.zone);
    if (result.status === 'aborted') this.rollbackAdapter();
    return result;
  }

  /** 回滚：session revert + adapter 重放到恢复点（dataModel 等协议状态一并恢复，v2 §10） */
  revert(steps = 1): RevertResult {
    const result = this.session.revert(this.zone, steps);
    if (result.status === 'reverted' && result.snapshot !== null) {
      // 剪除恢复点之后的帧记录（ring 内对应快照已不可达）
      const restoredSeq = result.snapshot.committedSeq;
      this.committedFrames = this.committedFrames.filter(
        (record) => record.committedSeq <= restoredSeq,
      );
    }
    this.rollbackAdapter();
    return result;
  }

  /** zone 锁定（v2 §9.2 最高优先级）：staged 被中止，adapter 回滚 */
  lock(): void {
    this.session.lockZone(this.zone);
    this.rollbackAdapter();
  }

  unlock(): void {
    this.session.unlockZone(this.zone);
  }

  /** 用户编辑了 pending 提案（v2 §11.2 编辑信号；随后 confirm 归 accept-after-edit） */
  noteUserEdit(): void {
    this.metrics.noteUserEdit(this.zone);
  }

  notePerfSample(label: string, ms: number): void {
    this.metrics.notePerfSample(label, ms);
  }

  /** 当前 adapter 协议状态快照（测量装置：外部可比对重放不变量） */
  adapterSnapshot(): AdapterResult {
    return this.adapter.snapshot();
  }

  /** 已提交帧记录（adapter 重放源，committedSeq 升序） */
  getCommittedFrames(): readonly CommittedFrameRecord[] {
    return this.committedFrames;
  }

  /** 当前 staged 提案的源帧（无 staged 时为 null） */
  getStagedFrame(): A2UIMessage | null {
    return this.stagedFrame;
  }

  state(): ClosedLoopState {
    return {
      zone: this.zone,
      surfaceId: this.surfaceId,
      applied: this.session.getApplied(this.zone),
      staged: this.session.getStaged(this.zone),
      denied: this.denied,
      locked: this.session.isZoneLocked(this.zone),
      queueFrames: this.queue.frameCount,
      resyncRequired: this.queue.resyncRequired,
    };
  }

  private processQueue(): void {
    for (;;) {
      const frame = this.queue.takeOldest();
      if (frame === null) break;
      this.processFrame(frame.payload);
    }
  }

  private processFrame(payload: JsonValue): void {
    const frame = asA2UIMessage(payload);
    if (frame === null) {
      this.denied = { reason: 'gate-error', message: 'frame is not a valid A2UI message' };
      this.rollbackAdapter();
      return;
    }
    let gateResult: GateResult;
    try {
      // 新提案基于 applied 基线（不叠加未确认效果）：先重放 committed 帧再应用新帧
      this.replayCommitted();
      const ir = this.applyFrame(frame);
      gateResult = gate(ir, this.gateOptions);
    } catch (error) {
      this.denied = { reason: 'gate-error', message: `frame evaluation failed: ${errorMessage(error)}` };
      this.rollbackAdapter();
      return;
    }
    const staged = this.session.stage(this.zone, gateResult, this.arbitration);
    if (staged.status === 'denied-blocked') {
      this.denied = { reason: 'blocked', message: 'proposal blocked by gate' };
      this.rollbackAdapter();
      return;
    }
    if (staged.status === 'denied-user-lock') {
      this.denied = { reason: 'user-lock', message: 'zone is locked by user' };
      this.rollbackAdapter();
      return;
    }
    this.denied = null;
    this.stagedFrame = frame;
  }

  /** 应用一帧并返回存活 surface 的 IR（surface 缺失/不可渲染即抛错 → gate-error，fail-closed） */
  private applyFrame(frame: A2UIMessage): IRNode {
    this.adapter.apply(frame);
    const snapshot = this.adapter.snapshot();
    const surface = snapshot.surfaces.find((entry) => entry.surfaceId === this.surfaceId);
    if (surface === undefined || surface.deleted || surface.ir === null) {
      throw new Error(`surface "${this.surfaceId}" is not renderable after applying frame`);
    }
    return surface.ir;
  }

  /** adapter 全量重放：reset + 依序应用已提交帧（v2 §5.2 重同步路径） */
  private replayCommitted(): void {
    this.adapter.reset();
    for (const record of this.committedFrames) {
      this.adapter.apply(record.message);
    }
  }

  /**
   * 丢弃未提交效果：adapter 重放到与 session 当前状态一致——
   * committed + staged（staged 存在则重放其源帧；被中止/提交后 stagedFrame 随之清空）。
   */
  private rollbackAdapter(): void {
    this.replayCommitted();
    const staged = this.session.getStaged(this.zone);
    if (staged === null) {
      this.stagedFrame = null;
      return;
    }
    if (this.stagedFrame === null) {
      throw new Error('internal invariant violation: staged proposal without a source frame');
    }
    this.adapter.apply(this.stagedFrame);
  }
}
