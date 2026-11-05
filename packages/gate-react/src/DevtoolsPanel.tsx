import type { ReactElement, ReactNode } from 'react';
import type {
  EventLogEntry,
  HealthRates,
  InteractionCounts,
  MetricsSnapshot,
  SessionEvent,
  ZoneReport,
} from '@genui/session';
import type { SurfaceState } from './controller';

/**
 * devtools 面板（v3 §6-M1：本地指标呈现，零网络出口）。
 *
 * - 纯展示组件：所有数据经 props 注入（宿主渲染体由 `SessionMetrics.snapshot()` 派生，
 *   同 DemoApp metrics 行口径——所有影响 counts 的事件必伴 SurfaceState 变化）；
 * - 零网络出口（v3 §11 OSS 口径）：无 fetch/XHR/sendBeacon，无任何 I/O；
 * - 比率 UI 不假设 ≤1（KAN-029/030：interactionRate、gateBlockRate 无上界）；
 * - 确定性：无时钟无随机，同一 snapshot 恒得同一渲染。
 */

const COUNT_ROWS: ReadonlyArray<readonly [keyof InteractionCounts, string]> = [
  ['proposals', 'proposals'],
  ['committed', 'committed'],
  ['transformedCommitted', 'transformedCommitted'],
  ['acceptAsIs', 'accept-as-is'],
  ['acceptAfterEdit', 'accept-after-edit'],
  ['autoApplied', 'auto-applied'],
  ['rollback', 'rollback'],
  ['ignore', 'ignore'],
  ['abandonedAfterEdit', 'abandoned-after-edit'],
  ['activeLock', 'active-lock'],
  ['dormantLock', 'dormant-lock'],
  ['deniedBlocked', 'denied-blocked'],
  ['deniedUserLock', 'denied-user-lock'],
  ['edits', 'edits'],
];

const RATE_ROWS: ReadonlyArray<readonly [keyof HealthRates, string]> = [
  ['interactionRate', 'interactionRate'],
  ['directAcceptRate', 'directAcceptRate'],
  ['rollbackRate', 'rollbackRate'],
  ['dormantShare', 'dormantShare'],
  ['gateBlockRate', 'gateBlockRate'],
  ['autoFixRate', 'autoFixRate'],
];

export interface DevtoolsPanelProps {
  /** 指标快照（宿主渲染体由 SessionMetrics.snapshot() 派生后注入） */
  readonly snapshot: MetricsSnapshot;
  /** 当前渲染面状态（可选：zone/locked/queueFrames/resyncRequired 呈现） */
  readonly surface?: SurfaceState | null;
  /** 渲染最近 N 条事件（默认全部；eventLog 本身有界，见 SessionMetrics maxEventLog） */
  readonly eventLimit?: number;
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : rate.toFixed(2);
}

/** 事件行详情（kind 特异字段；空串 = 无详情） */
function eventDetail(event: SessionEvent): string {
  switch (event.kind) {
    case 'staged':
      return `${event.proposalId} · ${event.verdict}`;
    case 'stage-denied':
      return event.reason;
    case 'staged-aborted':
      return `${event.proposalId} · ${event.reason}`;
    case 'committed':
      return `${event.proposalId}${event.userConfirmed ? ' · user-confirmed' : ''}`;
    case 'reverted':
      return `${event.restoredProposalId} · steps ${event.steps}`;
    case 'revert-failed':
      return `${event.reason} · steps ${event.steps}`;
    case 'snapshot-evicted':
      return event.proposalId;
    case 'zone-locked':
      return event.abortedStagedId === null ? '' : `aborted ${event.abortedStagedId}`;
    case 'zone-unlocked':
      return '';
  }
}

function eventLine(entry: EventLogEntry): string {
  const detail = eventDetail(entry.event);
  const suffix = detail === '' ? '' : ` ${detail}`;
  return `#${entry.seq} ${entry.event.kind} [${entry.event.zone}]${suffix}`;
}

function SurfaceLine({ surface }: { readonly surface: SurfaceState }): ReactElement {
  return (
    <p data-testid="devtools-surface">
      zone {surface.zone} · locked {String(surface.locked)} · queueFrames {surface.queueFrames} · resyncRequired{' '}
      {String(surface.resyncRequired)}
      {surface.denied !== null ? ` · denied ${surface.denied.reason}` : ''}
    </p>
  );
}

function ReportBlock({ report, testPrefix }: { readonly report: ZoneReport; readonly testPrefix: string }): ReactElement {
  const isGlobal = report.zone === '*';
  const nodes: ReactNode = (
    <>
      <dl data-testid={`${testPrefix}-counts`}>
        {COUNT_ROWS.map(([field, label]) => (
          <div key={field} data-testid={`${testPrefix}-count-${field}`}>
            <dt>{label}</dt>
            {' '}
            <dd>{report.counts[field]}</dd>
          </div>
        ))}
      </dl>
      <dl data-testid={`${testPrefix}-rates`}>
        {RATE_ROWS.map(([field, label]) => (
          <div key={field} data-testid={`${testPrefix}-rate-${field}`}>
            <dt>{label}</dt>
            {' '}
            <dd>{formatRate(report.rates[field])}</dd>
          </div>
        ))}
      </dl>
      <p data-testid={`${testPrefix}-health`}>
        engagement {report.health.engagementGate}
        {report.health.falseGreenRisk ? ' · false-green risk' : ''}
      </p>
    </>
  );
  return isGlobal ? <section data-testid="devtools-global">{nodes}</section> : (
    <section data-testid={`devtools-zone-${report.zone}`}>{nodes}</section>
  );
}

export function DevtoolsPanel({ snapshot, surface = null, eventLimit }: DevtoolsPanelProps): ReactElement {
  const log = snapshot.eventLog;
  const bounded = eventLimit === undefined ? log : log.slice(Math.max(0, log.length - eventLimit));
  // 最新在前（devtools 惯例；eventLog 存储序为最旧在前）
  const recent = [...bounded].reverse();
  return (
    <section data-genui-devtools="">
      <h2>Devtools — session metrics</h2>
      {surface !== null ? <SurfaceLine surface={surface} /> : null}
      <ReportBlock report={snapshot.global} testPrefix="devtools" />
      {snapshot.zones.map((zone) => (
        <ReportBlock key={zone.zone} report={zone} testPrefix={`devtools-zone-${zone.zone}`} />
      ))}
      <ol data-testid="devtools-events">
        {recent.map((entry) => (
          <li key={entry.seq} data-testid={`devtools-event-${entry.seq}`}>
            {eventLine(entry)}
          </li>
        ))}
      </ol>
    </section>
  );
}
