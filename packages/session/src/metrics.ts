import type { VerdictAction } from '@genui/gate';
import type { SessionEvent } from './types';

/**
 * 会话本地指标（v2 §11，开源版口径）。
 *
 * 反 gaming 原则（v2 §11.2）：所有指标度量用户可观测行为，不采信 Agent 自评——
 * Agent 未确认直接 commit 记 autoApplied，不进交互分子。
 */

/** 全局聚合报告的 zone 标签（保留名：宿主 zone 不得使用 `'*'`） */
export const GLOBAL_ZONE = '*';

/**
 * 提案交互分类（v2 §11.2 五类 + 开源版补充类），与 InteractionCounts 计数字段一一对应：
 *
 * - accept-as-is → acceptAsIs：确认且未编辑
 * - accept-after-edit → acceptAfterEdit：编辑后确认
 * - auto-applied → autoApplied：未带用户确认的 commit（不进交互分子）
 * - rollback → rollback：应用后回滚（按 revert 步数累计）
 * - ignore → ignore：提案 abort/被取代，零交互
 * - abandoned-after-edit → abandonedAfterEdit：编辑后放弃（诊断量，五类外补集）
 * - active-lock / dormant-lock → activeLock / dormantLock：锁定时该 zone 此前有/无交互
 * - denied-blocked / denied-user-lock → deniedBlocked / deniedUserLock：stage 被拒
 */
export type InteractionClass =
  | 'accept-as-is'
  | 'accept-after-edit'
  | 'auto-applied'
  | 'rollback'
  | 'ignore'
  | 'abandoned-after-edit'
  | 'active-lock'
  | 'dormant-lock'
  | 'denied-blocked'
  | 'denied-user-lock';

/** 交互计数快照（v2 §11.2：单指标全部降级为诊断量，Go/No-Go 用组合口径） */
export interface InteractionCounts {
  /** 进入提案流程的提案数（staged；被 gate/锁拒绝的不计） */
  readonly proposals: number;
  /** 已应用（commit 边界）数 = committedFrames */
  readonly committed: number;
  /** verdict 为 transform 且已 commit 的提案数 = transformedFrames */
  readonly transformedCommitted: number;
  readonly acceptAsIs: number;
  readonly acceptAfterEdit: number;
  readonly autoApplied: number;
  readonly rollback: number;
  readonly ignore: number;
  readonly abandonedAfterEdit: number;
  readonly activeLock: number;
  readonly dormantLock: number;
  readonly deniedBlocked: number;
  readonly deniedUserLock: number;
  /** 用户编辑次数（noteUserEdit 上报，诊断量） */
  readonly edits: number;
}

/** 健康比率：分母为 0 时为 null（不下断言） */
export interface HealthRates {
  /** 交互率 = (acceptAsIs + acceptAfterEdit + rollback) / proposals（v2 §11.2 ≥ 30% [假设，P0 校准点]）。
   *  可超过 1：rollback 按 revert 步累计，accept 后又回滚的提案贡献 2 次交互 */
  readonly interactionRate: number | null;
  /** 直接接受率 = acceptAsIs / (acceptAsIs + acceptAfterEdit + rollback) */
  readonly directAcceptRate: number | null;
  /** 回滚率 = rollback / committed */
  readonly rollbackRate: number | null;
  /** 休眠占比 = dormantLock / (activeLock + dormantLock) */
  readonly dormantShare: number | null;
  /** gate 拦截率 = deniedBlocked / committed（诊断量，v2 §11.2） */
  readonly gateBlockRate: number | null;
  /** 自动修复率 = transformedCommitted / committed（诊断量，v2 §11.2） */
  readonly autoFixRate: number | null;
}

/** 交互门槛（v2 §11.2 Go/No-Go 组合口径） */
export type EngagementGate = 'pass' | 'fail' | 'insufficient-data';

export interface HealthVerdict {
  /** 交互率是否达标：无提案时 insufficient-data，否则按 engagementThreshold 判 pass/fail */
  readonly engagementGate: EngagementGate;
  /**
   * 假绿风险（v2 §11.2/§17-P1 出口③）：交互率不达标（用户没在看 Agent 编排）
   * 且回滚率低于 rollbackThreshold——此时「回滚率低」不是质量信号，判 No-Go。
   */
  readonly falseGreenRisk: boolean;
}

/** 事件日志条目：metrics 内部序号（1 起单调）+ 原始事件 */
export interface EventLogEntry {
  readonly seq: number;
  readonly event: SessionEvent;
}

/** 各阶段耗时统计（宿主计时上报；stats 只覆盖被采样记录的样本） */
export interface PerfStat {
  readonly label: string;
  readonly samples: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/** 单 zone（或全局聚合 zone='*'）指标报告 */
export interface ZoneReport {
  readonly zone: string;
  readonly counts: InteractionCounts;
  readonly rates: HealthRates;
  readonly health: HealthVerdict;
  /** 该 zone 是否出现过用户交互（accept / 编辑 / 回滚） */
  readonly everInteracted: boolean;
  /** 当前 pending 提案 id（全局聚合恒为 null） */
  readonly pendingProposalId: string | null;
}

export interface MetricsSnapshot {
  /** 各 zone 报告，按 zone 名字典序 */
  readonly zones: readonly ZoneReport[];
  /** 全局聚合（zone = '*'） */
  readonly global: ZoneReport;
  /** 有界事件日志，按发生序（最旧在前） */
  readonly eventLog: readonly EventLogEntry[];
  /** 各阶段耗时统计，按 label 字典序 */
  readonly perf: readonly PerfStat[];
}

export interface SessionMetricsOptions {
  /** 交互率门槛（默认 0.3 `[假设，P0 校准点]`） */
  readonly engagementThreshold?: number;
  /** 假绿判定的回滚率门槛（默认 0.2 `[假设]`） */
  readonly rollbackThreshold?: number;
  /** 事件日志容量（默认 100 条 `[假设]`，溢出丢最旧并计数于 seq 间隙） */
  readonly maxEventLog?: number;
  /** perf 确定性采样间隔：每第 N 次调用记录一个样本（默认 10，替代随机 10% `[假设]`） */
  readonly perfSampleEvery?: number;
}

interface PendingInfo {
  readonly proposalId: string;
  readonly verdict: VerdictAction;
  edited: boolean;
}

interface ZoneState {
  proposals: number;
  committed: number;
  transformedCommitted: number;
  acceptAsIs: number;
  acceptAfterEdit: number;
  autoApplied: number;
  rollback: number;
  ignore: number;
  abandonedAfterEdit: number;
  activeLock: number;
  dormantLock: number;
  deniedBlocked: number;
  deniedUserLock: number;
  edits: number;
  everInteracted: boolean;
  pending: PendingInfo | null;
}

interface PerfState {
  calls: number;
  samples: number;
  minMs: number;
  maxMs: number;
  sumMs: number;
}

function newZoneState(): ZoneState {
  return {
    proposals: 0,
    committed: 0,
    transformedCommitted: 0,
    acceptAsIs: 0,
    acceptAfterEdit: 0,
    autoApplied: 0,
    rollback: 0,
    ignore: 0,
    abandonedAfterEdit: 0,
    activeLock: 0,
    dormantLock: 0,
    deniedBlocked: 0,
    deniedUserLock: 0,
    edits: 0,
    everInteracted: false,
    pending: null,
  };
}

function assertZone(zone: string): void {
  if (typeof zone !== 'string' || zone === '') {
    throw new RangeError('zone must be a non-empty string');
  }
  if (zone === GLOBAL_ZONE) {
    throw new RangeError(`zone name "${GLOBAL_ZONE}" is reserved for the global aggregate report`);
  }
}

/**
 * 会话本地指标聚合器（v2 §11.1/§11.2，开源版：零网络出口，仅内存聚合 + snapshot 导出）。
 *
 * 接线：`const metrics = new SessionMetrics(); new ProposalSession({ onEvent: metrics.onEvent })`
 * （onEvent 为绑定箭头函数，可直接传递）。补充信号由宿主显式上报：
 * - `noteUserEdit(zone)`：用户编辑了该 zone 的 pending 提案（无内嵌时钟，事件序即依据）；
 * - `notePerfSample(label, ms)`：各阶段耗时（宿主计时，metrics 不解释 label 语义）。
 *
 * 确定性：无时钟无随机，序号全为内部单调计数；同一调用序列恒得同一 snapshot。
 */
export class SessionMetrics {
  private readonly engagementThreshold: number;
  private readonly rollbackThreshold: number;
  private readonly maxEventLog: number;
  private readonly perfSampleEvery: number;
  private readonly zones = new Map<string, ZoneState>();
  private readonly perf = new Map<string, PerfState>();
  private readonly log: EventLogEntry[] = [];
  private eventSeq = 0;

  constructor(options: SessionMetricsOptions = {}) {
    const engagementThreshold = options.engagementThreshold ?? 0.3;
    const rollbackThreshold = options.rollbackThreshold ?? 0.2;
    const maxEventLog = options.maxEventLog ?? 100;
    const perfSampleEvery = options.perfSampleEvery ?? 10;
    for (const [name, value] of [
      ['engagementThreshold', engagementThreshold],
      ['rollbackThreshold', rollbackThreshold],
    ] as Array<[string, number]>) {
      if (typeof value !== 'number' || Number.isNaN(value) || value <= 0 || value > 1) {
        throw new RangeError(`${name} must be a number in (0, 1], got ${value}`);
      }
    }
    for (const [name, value] of [
      ['maxEventLog', maxEventLog],
      ['perfSampleEvery', perfSampleEvery],
    ] as Array<[string, number]>) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer, got ${value}`);
      }
    }
    this.engagementThreshold = engagementThreshold;
    this.rollbackThreshold = rollbackThreshold;
    this.maxEventLog = maxEventLog;
    this.perfSampleEvery = perfSampleEvery;
  }

  /** 事件流入口（可直接作为 ProposalSessionOptions.onEvent 使用） */
  readonly onEvent = (event: SessionEvent): void => {
    // 全事件种类统一校验 zone（含保留名 '*'），无状态副作用
    assertZone(event.zone);
    switch (event.kind) {
      case 'staged': {
        const z = this.zoneState(event.zone);
        z.proposals += 1;
        z.pending = { proposalId: event.proposalId, verdict: event.verdict, edited: false };
        break;
      }
      case 'stage-denied': {
        const z = this.zoneState(event.zone);
        if (event.reason === 'blocked') {
          z.deniedBlocked += 1;
        } else {
          z.deniedUserLock += 1;
        }
        break;
      }
      case 'staged-aborted': {
        const z = this.zoneState(event.zone);
        const pending = z.pending;
        // 未见 staged 的 abort（宿主事件流缺序）不归类
        if (pending !== null) {
          if (pending.edited) {
            z.abandonedAfterEdit += 1;
          } else {
            z.ignore += 1;
          }
          z.pending = null;
        }
        break;
      }
      case 'committed': {
        const z = this.zoneState(event.zone);
        z.committed += 1;
        const pending = z.pending;
        if (pending !== null) {
          if (pending.verdict === 'transform') {
            z.transformedCommitted += 1;
          }
          if (event.userConfirmed) {
            if (pending.edited) {
              z.acceptAfterEdit += 1;
            } else {
              z.acceptAsIs += 1;
            }
            z.everInteracted = true;
          } else {
            z.autoApplied += 1;
          }
          z.pending = null;
        } else if (event.userConfirmed) {
          // 防御：未见 staged 的 committed（宿主事件流缺序）按零编辑归类
          z.acceptAsIs += 1;
          z.everInteracted = true;
        } else {
          z.autoApplied += 1;
        }
        break;
      }
      case 'reverted': {
        const z = this.zoneState(event.zone);
        z.rollback += event.steps;
        z.everInteracted = true;
        break;
      }
      case 'zone-locked': {
        const z = this.zoneState(event.zone);
        if (z.everInteracted) {
          z.activeLock += 1;
        } else {
          z.dormantLock += 1;
        }
        break;
      }
      case 'revert-failed':
      case 'snapshot-evicted':
      case 'zone-unlocked':
        break;
      default:
        throw new RangeError(`unknown SessionEvent kind: ${JSON.stringify(event)}`);
    }
    this.appendLog(event);
  };

  /** 宿主上报：用户编辑了该 zone 的 pending 提案（§11.2 acceptAfterEdit/activeLock 依据） */
  noteUserEdit(zone: string): void {
    const z = this.zoneState(zone);
    z.edits += 1;
    z.everInteracted = true;
    if (z.pending !== null) {
      z.pending.edited = true;
    }
  }

  /** 宿主上报：某阶段耗时样本（确定性每第 perfSampleEvery 次调用记录一个） */
  notePerfSample(label: string, ms: number): void {
    if (typeof label !== 'string' || label === '') {
      throw new RangeError('label must be a non-empty string');
    }
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ms must be a finite number >= 0, got ${ms}`);
    }
    let p = this.perf.get(label);
    if (p === undefined) {
      p = { calls: 0, samples: 0, minMs: 0, maxMs: 0, sumMs: 0 };
      this.perf.set(label, p);
    }
    p.calls += 1;
    if (p.calls % this.perfSampleEvery === 0) {
      if (p.samples === 0) {
        p.minMs = ms;
        p.maxMs = ms;
      } else {
        if (ms < p.minMs) p.minMs = ms;
        if (ms > p.maxMs) p.maxMs = ms;
      }
      p.samples += 1;
      p.sumMs += ms;
    }
  }

  /** 指标快照：zones 按字典序 + 全局聚合（'*'）+ 有界事件日志 + perf 统计。幂等，不改变内部状态 */
  snapshot(): MetricsSnapshot {
    const zoneReports = [...this.zones.keys()].sort().map((zone) => {
      const z = this.zones.get(zone)!;
      return this.report(zone, z);
    });
    const global = newZoneState();
    for (const z of this.zones.values()) {
      global.proposals += z.proposals;
      global.committed += z.committed;
      global.transformedCommitted += z.transformedCommitted;
      global.acceptAsIs += z.acceptAsIs;
      global.acceptAfterEdit += z.acceptAfterEdit;
      global.autoApplied += z.autoApplied;
      global.rollback += z.rollback;
      global.ignore += z.ignore;
      global.abandonedAfterEdit += z.abandonedAfterEdit;
      global.activeLock += z.activeLock;
      global.dormantLock += z.dormantLock;
      global.deniedBlocked += z.deniedBlocked;
      global.deniedUserLock += z.deniedUserLock;
      global.edits += z.edits;
      global.everInteracted ||= z.everInteracted;
    }
    return {
      zones: zoneReports,
      global: this.report(GLOBAL_ZONE, global),
      eventLog: [...this.log],
      perf: [...this.perf.keys()].sort().map((label) => {
        const p = this.perf.get(label)!;
        return { label, samples: p.samples, minMs: p.minMs, maxMs: p.maxMs, meanMs: p.sumMs / p.samples };
      }),
    };
  }

  private report(zone: string, z: ZoneState): ZoneReport {
    const counts: InteractionCounts = {
      proposals: z.proposals,
      committed: z.committed,
      transformedCommitted: z.transformedCommitted,
      acceptAsIs: z.acceptAsIs,
      acceptAfterEdit: z.acceptAfterEdit,
      autoApplied: z.autoApplied,
      rollback: z.rollback,
      ignore: z.ignore,
      abandonedAfterEdit: z.abandonedAfterEdit,
      activeLock: z.activeLock,
      dormantLock: z.dormantLock,
      deniedBlocked: z.deniedBlocked,
      deniedUserLock: z.deniedUserLock,
      edits: z.edits,
    };
    return {
      zone,
      counts,
      rates: this.ratesOf(counts),
      health: this.healthOf(counts),
      everInteracted: z.everInteracted,
      pendingProposalId: z.pending?.proposalId ?? null,
    };
  }

  private ratesOf(c: InteractionCounts): HealthRates {
    const interacting = c.acceptAsIs + c.acceptAfterEdit + c.rollback;
    return {
      interactionRate: c.proposals === 0 ? null : interacting / c.proposals,
      directAcceptRate: interacting === 0 ? null : c.acceptAsIs / interacting,
      rollbackRate: c.committed === 0 ? null : c.rollback / c.committed,
      dormantShare: c.activeLock + c.dormantLock === 0 ? null : c.dormantLock / (c.activeLock + c.dormantLock),
      gateBlockRate: c.committed === 0 ? null : c.deniedBlocked / c.committed,
      autoFixRate: c.committed === 0 ? null : c.transformedCommitted / c.committed,
    };
  }

  private healthOf(c: InteractionCounts): HealthVerdict {
    if (c.proposals === 0) {
      return { engagementGate: 'insufficient-data', falseGreenRisk: false };
    }
    const interacting = c.acceptAsIs + c.acceptAfterEdit + c.rollback;
    const interactionRate = interacting / c.proposals;
    if (interactionRate >= this.engagementThreshold) {
      return { engagementGate: 'pass', falseGreenRisk: false };
    }
    const rollbackRate = c.committed === 0 ? null : c.rollback / c.committed;
    const falseGreenRisk = rollbackRate !== null && rollbackRate < this.rollbackThreshold;
    return { engagementGate: 'fail', falseGreenRisk };
  }

  private zoneState(zone: string): ZoneState {
    assertZone(zone);
    let z = this.zones.get(zone);
    if (z === undefined) {
      z = newZoneState();
      this.zones.set(zone, z);
    }
    return z;
  }

  private appendLog(event: SessionEvent): void {
    this.eventSeq += 1;
    this.log.push({ seq: this.eventSeq, event });
    if (this.log.length > this.maxEventLog) {
      this.log.shift();
    }
  }
}
