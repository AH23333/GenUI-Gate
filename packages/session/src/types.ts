import type { TraceEntry, VerdictAction } from '@genui/gate';
import type { IRNode } from '@genui/ir';
import type { ArbitrationResult, ConfirmationPolicy } from './arbitration';
import type { ProposalDiff } from './diff';

/** 进行中请求的取消令牌（§10）：回滚即取消。宿主可用 AbortController 结构适配 */
export interface AbortToken {
  abort(): void;
}

/** 已 stage 的提案（预览与 commit 消费同一个 IR′ 对象，v2 §9.1） */
export interface StagedProposal {
  /** 会话内全局唯一、确定性（`p${seq}`，无时钟无随机） */
  readonly id: string;
  readonly zone: string;
  readonly seq: number;
  /** IR′：gate 输出树。预览、commit、快照共享同一引用（不可变树 + 结构共享） */
  readonly irPrime: IRNode;
  readonly irPrimeHash: string;
  readonly verdict: VerdictAction;
  /** gate trace（原序）+ 仲裁 trace 条目（固定求值序，v2 §9.2 结果进 trace） */
  readonly trace: readonly TraceEntry[];
  readonly arbitration: ArbitrationResult;
  readonly confirmation: ConfirmationPolicy;
  /** 相对 stage 时 applied 状态的 diff（v2 §9.1）。revert 后基线变化不自动重算 */
  readonly diff: ProposalDiff;
}

/** 已 commit 的提案 = 快照内容（v2 §10：仅 commit 边界快照，环形 N=20） */
export interface CommittedProposal extends StagedProposal {
  readonly committedSeq: number;
  /** best-effort 焦点提示：宿主 commit 时提供，revert 时原样返还，Session 不解释 */
  readonly focusHint: string | null;
  /** commit 时该 zone 已注册的 inflight 数量（审计记录；活引用不进快照） */
  readonly inflightCount: number;
}

export interface StageResult {
  readonly status: 'staged' | 'denied-blocked' | 'denied-user-lock';
  /** 非 null 当且仅当 status === 'staged' */
  readonly proposal: StagedProposal | null;
  /** 被「新提案到达 → 旧提案 aborted」语义 aborted 的前 staged id（v2 §9.1） */
  readonly abortedPreviousId: string | null;
  readonly arbitration: ArbitrationResult;
}

export interface CommitOptions {
  /** 确认凭据：staged 需要确认（verdict requireApproval 或 confirmation user-confirm）时必须为 true */
  readonly confirmed?: boolean;
  readonly focusHint?: string;
}

export interface CommitResult {
  readonly status: 'committed' | 'no-staged' | 'confirmation-required';
  /** 非 null 当且仅当 status === 'committed'；irPrime 与 staged 是同一对象（v2 §9.1 判定标准） */
  readonly proposal: CommittedProposal | null;
  /** 被 superseded 的前一 applied 提案 id（首个 commit 为 null） */
  readonly supersededId: string | null;
}

export interface AbortResult {
  readonly status: 'aborted' | 'no-staged';
  readonly abortedId: string | null;
}

export interface RevertResult {
  readonly status: 'reverted' | 'no-snapshot' | 'snapshot-corrupted';
  /** 恢复到的快照（reverted 时非 null） */
  readonly snapshot: CommittedProposal | null;
  /** 被回滚的 applied 提案 id（reverted 时非 null） */
  readonly revertedProposalId: string | null;
  /** 本次回滚取消的 inflight 令牌数（v2 §10 回滚执行序第 1 步） */
  readonly cancelledInflight: number;
}

/** 状态机迁移事件流（1.8 本地指标的事件源；确定性，无时钟无随机） */
export type SessionEvent =
  | { kind: 'staged'; zone: string; proposalId: string; seq: number }
  | { kind: 'stage-denied'; zone: string; reason: 'blocked' | 'user-lock'; seq: number }
  | { kind: 'staged-aborted'; zone: string; proposalId: string; reason: 'superseded-by-newer' | 'zone-locked' | 'user-abort'; seq: number }
  | { kind: 'committed'; zone: string; proposalId: string; committedSeq: number; supersededId: string | null }
  | { kind: 'reverted'; zone: string; restoredProposalId: string; revertedProposalId: string | null; steps: number; cancelledInflight: number }
  | { kind: 'revert-failed'; zone: string; reason: 'no-snapshot' | 'snapshot-corrupted'; steps: number }
  | { kind: 'snapshot-evicted'; zone: string; proposalId: string }
  | { kind: 'zone-locked'; zone: string; abortedStagedId: string | null }
  | { kind: 'zone-unlocked'; zone: string };

export interface ProposalSessionOptions {
  /** 快照环形缓冲容量（v2 §10：N=20 `[假设，P0 校准点]`，默认 20） */
  readonly ringSize?: number;
  /** 迁移事件回调（状态已先行落定；回调抛错会向上传播，回调不应抛错） */
  readonly onEvent?: (event: SessionEvent) => void;
}
