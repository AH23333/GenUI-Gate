import type { GateResult } from '@genui/gate';
import type { JsonValue } from '@genui/ir';
import { PendingFrameQueue } from '@genui/session';
import type {
  AbortResult,
  ArbitrationRequest,
  CommitResult,
  CommittedProposal,
  IngestResult,
  ProposalSession,
  RevertResult,
  StagedProposal,
} from '@genui/session';

/** 拒绝/降级原因（v2 §14 失败矩阵 gate / renderer / pending 帧行） */
export type DeniedReason = 'blocked' | 'user-lock' | 'gate-error';

export interface DeniedState {
  readonly reason: DeniedReason;
  readonly message: string;
}

/** 面向渲染的不可变状态快照（GateSurface 经 useSyncExternalStore 订阅） */
export interface SurfaceState {
  readonly zone: string;
  readonly applied: CommittedProposal | null;
  readonly staged: StagedProposal | null;
  readonly denied: DeniedState | null;
  readonly locked: boolean;
  readonly queueFrames: number;
  readonly resyncRequired: boolean;
}

export interface GateSurfaceOptions {
  readonly zone: string;
  readonly session: ProposalSession;
  /** 帧 → gate 结果（宿主接线：adapter 解析帧后调 gate()；本控制器不解析协议） */
  readonly evaluate: (frame: JsonValue) => GateResult;
  readonly queue?: PendingFrameQueue;
  /**
   * 优先级仲裁请求（v2 §9.2），逐帧透传 session.stage。
   * autoCommit 只自动应用低风险提案（确认策略 auto/never）；
   * 保守默认 user-confirm 下 autoCommit 不生效——一切提案等人工确认。
   */
  readonly arbitration?: ArbitrationRequest;
  /**
   * 低风险提案（verdict pass/transform 且确认策略非 user-confirm）在帧边界自动 commit
   * （v2 §5.2 流式语义：commit 边界 verdict 为 pass/transform → 摘除 inert）。
   * 默认 false：一切提案进入人工预览（产品主叙事：预览 → 确认 → 回滚）。
   */
  readonly autoCommit?: boolean;
}

/**
 * `GateSurface` 所需的最小控制器契约（结构化接口，1.11 demo app 引入）：
 * `GateSurfaceController` 类实现之；宿主侧桥接对象（如 demo app 的 ClosedLoop 桥）亦可结构化满足。
 * 硬性要求：`getSnapshot` 须缓存——状态不变期间多次调用返回同一引用（useSyncExternalStore 要求）。
 */
export interface SurfaceController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SurfaceState;
  confirm(): CommitResult;
  abortPreview(): AbortResult;
}

/** staged 提案是否需要人工确认（与 ProposalSession.commit 的 fail-closed 把门口径一致） */
function needsConfirmation(proposal: StagedProposal): boolean {
  return proposal.verdict === 'requireApproval' || proposal.confirmation === 'user-confirm';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sameSurfaceState(a: SurfaceState, b: SurfaceState): boolean {
  return (
    a.applied === b.applied &&
    a.staged === b.staged &&
    a.denied === b.denied &&
    a.locked === b.locked &&
    a.queueFrames === b.queueFrames &&
    a.resyncRequired === b.resyncRequired
  );
}

/**
 * 帧边界 commit 流控制器（v2 §5.2）——纯逻辑、零 react 依赖、确定性：
 *
 * ```
 * 帧 payload ──ingest──► PendingFrameQueue（背压 + 整帧隔离）
 *      │
 *      └─processQueue──► takeOldest() ──► evaluate(帧) ──► ProposalSession.stage()
 *                            │                                │
 *                            │                 ┌──────────────┴──────────────┐
 *                            │             staged（pending-inert 预览）      denied
 *                            │             autoCommit 且低风险 → commit      └─► fallback（§14）
 *                            └─ resync 背压标志透出，宿主 reset + 重放后 clearQueue()
 * ```
 *
 * - 事件流：Session 迁移事件经宿主构造 ProposalSession 时注入的 onEvent 直达 SessionMetrics；
 * - autoCommit 的 commit 不带 confirmed → 指标记 autoApplied（userConfirmed=false）；
 *   人工确认走 confirm()（confirmed: true）→ acceptAsIs / acceptAfterEdit 口径（KAN-026）；
 * - evaluate 抛错：单帧 quarantine（denied=gate-error），队列继续（v2 §14 gate 行 fail-closed）。
 */
export class GateSurfaceController implements SurfaceController {
  private readonly zone: string;
  private readonly session: ProposalSession;
  private readonly queue: PendingFrameQueue;
  private readonly evaluate: (frame: JsonValue) => GateResult;
  private readonly autoCommit: boolean;
  private readonly arbitration?: ArbitrationRequest;
  private readonly listeners = new Set<() => void>();
  private denied: DeniedState | null = null;
  private state: SurfaceState;

  /** 绑定箭头（SessionMetrics.onEvent 同款）：可直接传给 useSyncExternalStore */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SurfaceState => {
    return this.state;
  };

  constructor(options: GateSurfaceOptions) {
    if (typeof options.zone !== 'string' || options.zone === '') {
      throw new RangeError('zone must be a non-empty string');
    }
    if (
      typeof options.session.stage !== 'function' ||
      typeof options.session.commit !== 'function'
    ) {
      throw new TypeError('session must be a ProposalSession');
    }
    if (typeof options.evaluate !== 'function') {
      throw new TypeError('evaluate must be a function');
    }
    this.zone = options.zone;
    this.session = options.session;
    this.queue = options.queue ?? new PendingFrameQueue();
    this.evaluate = options.evaluate;
    this.autoCommit = options.autoCommit === true;
    this.arbitration = options.arbitration;
    this.state = this.computeState();
  }

  /** 帧入队（背压/整帧隔离语义见 PendingFrameQueue） */
  ingestFrame(payload: unknown): IngestResult {
    const result = this.queue.ingest(payload);
    this.refresh();
    return result;
  }

  /** 帧边界 commit 流：消费最旧帧直至清空，返回处理帧数 */
  processQueue(): number {
    let processed = 0;
    for (;;) {
      const frame = this.queue.takeOldest();
      if (frame === null) break;
      this.processFrame(frame.payload);
      processed += 1;
    }
    this.refresh();
    return processed;
  }

  /** 人工确认（Apply）：commit(confirmed: true) → 指标记 userConfirmed */
  confirm(): CommitResult {
    const result = this.session.commit(this.zone, { confirmed: true });
    this.refresh();
    return result;
  }

  /** 人工拒绝（Discard） */
  abortPreview(): AbortResult {
    const result = this.session.abort(this.zone);
    this.refresh();
    return result;
  }

  revert(steps = 1): RevertResult {
    const result = this.session.revert(this.zone, steps);
    this.refresh();
    return result;
  }

  lock(): void {
    this.session.lockZone(this.zone);
    this.refresh();
  }

  unlock(): void {
    this.session.unlockZone(this.zone);
    this.refresh();
  }

  /** 背压后重同步路径：清空帧队列（宿主随后 reset adapter + 全量重放） */
  clearQueue(): void {
    this.queue.clear();
    this.refresh();
  }

  private processFrame(frame: JsonValue): void {
    let gateResult: GateResult;
    try {
      gateResult = this.evaluate(frame);
    } catch (error) {
      this.denied = { reason: 'gate-error', message: `Gate evaluation failed: ${errorMessage(error)}` };
      return;
    }
    const staged = this.session.stage(this.zone, gateResult, this.arbitration);
    if (staged.status === 'denied-blocked') {
      this.denied = { reason: 'blocked', message: 'Proposal blocked by gate' };
      return;
    }
    if (staged.status === 'denied-user-lock') {
      this.denied = { reason: 'user-lock', message: 'Zone is locked by user' };
      return;
    }
    this.denied = null;
    const proposal = staged.proposal;
    if (proposal !== null && this.autoCommit && !needsConfirmation(proposal)) {
      // 低风险自动应用（v2 §5.2）：不带 confirmed → 指标记 autoApplied
      this.session.commit(this.zone);
    }
  }

  private computeState(): SurfaceState {
    return {
      zone: this.zone,
      applied: this.session.getApplied(this.zone),
      staged: this.session.getStaged(this.zone),
      denied: this.denied,
      locked: this.session.isZoneLocked(this.zone),
      queueFrames: this.queue.frameCount,
      resyncRequired: this.queue.resyncRequired,
    };
  }

  private refresh(): void {
    const next = this.computeState();
    if (sameSurfaceState(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
