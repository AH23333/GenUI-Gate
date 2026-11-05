// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { VerdictAction } from '@genui/gate';
import type { SessionEvent } from '@genui/session';
import { SessionMetrics } from '@genui/session';
import type { SurfaceState } from '../src/controller';
import { DevtoolsPanel } from '../src/DevtoolsPanel';

afterEach(cleanup);

function staged(seq: number, verdict: VerdictAction): SessionEvent {
  return { kind: 'staged', zone: 'main', proposalId: `p${seq}`, seq, verdict };
}

function committed(seq: number, userConfirmed: boolean): SessionEvent {
  return { kind: 'committed', zone: 'main', proposalId: `p${seq}`, committedSeq: seq, supersededId: null, userConfirmed };
}

function reverted(): SessionEvent {
  return { kind: 'reverted', zone: 'main', restoredProposalId: 'p1', revertedProposalId: 'p2', steps: 1, cancelledInflight: 0 };
}

const SURFACE: SurfaceState = {
  zone: 'main',
  applied: null,
  staged: null,
  denied: null,
  locked: false,
  queueFrames: 0,
  resyncRequired: false,
};

function textOf(id: string): string {
  return document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
}

function drive(...events: SessionEvent[]): SessionMetrics {
  const metrics = new SessionMetrics();
  for (const event of events) {
    metrics.onEvent(event);
  }
  return metrics;
}

describe('DevtoolsPanel（本地指标呈现，零网络出口）', () => {
  it('空快照：全比率 null 显示占位符，engagement insufficient-data，事件列表空', () => {
    const metrics = new SessionMetrics();
    render(<DevtoolsPanel snapshot={metrics.snapshot()} surface={SURFACE} />);
    expect(textOf('devtools-rate-interactionRate')).toBe('interactionRate —');
    expect(textOf('devtools-rate-gateBlockRate')).toBe('gateBlockRate —');
    expect(textOf('devtools-count-proposals')).toBe('proposals 0');
    expect(textOf('devtools-health')).toBe('engagement insufficient-data');
    expect(textOf('devtools-surface')).toBe('zone main · locked false · queueFrames 0 · resyncRequired false');
    expect(document.querySelector('[data-testid="devtools-events"]')?.children).toHaveLength(0);
  });

  it('交互全链路：staged → committed → reverted 计数/比率/事件行渲染', () => {
    const metrics = drive(
      staged(1, 'pass'),
      committed(1, true),
      staged(2, 'transform'),
      committed(2, true),
      reverted(),
    );
    render(<DevtoolsPanel snapshot={metrics.snapshot()} surface={SURFACE} />);
    expect(textOf('devtools-count-proposals')).toBe('proposals 2');
    expect(textOf('devtools-count-committed')).toBe('committed 2');
    expect(textOf('devtools-count-rollback')).toBe('rollback 1');
    expect(textOf('devtools-rate-interactionRate')).toBe('interactionRate 1.50'); // >1 不假设上界（KAN-029）
    expect(textOf('devtools-rate-directAcceptRate')).toBe('directAcceptRate 0.67');
    expect(textOf('devtools-health')).toBe('engagement pass');
  });

  it('事件行：最新在前 + kind 特异详情 + seq 稳定 testid', () => {
    const metrics = drive(
      staged(1, 'pass'),
      committed(1, true),
      { kind: 'stage-denied', zone: 'main', reason: 'blocked', seq: 3 },
      { kind: 'zone-locked', zone: 'main', abortedStagedId: 'p1' },
      { kind: 'zone-unlocked', zone: 'main' },
    );
    render(<DevtoolsPanel snapshot={metrics.snapshot()} />);
    const items = [...document.querySelectorAll('[data-testid="devtools-events"] li')];
    expect(items.map((li) => li.textContent)).toEqual([
      '#5 zone-unlocked [main]',
      '#4 zone-locked [main] aborted p1',
      '#3 stage-denied [main] blocked',
      '#2 committed [main] p1 · user-confirmed',
      '#1 staged [main] p1 · pass',
    ]);
    expect(document.querySelector('[data-testid="devtools-event-3"]')).not.toBeNull();
  });

  it('eventLimit：仅渲染最近 N 条（最旧端截断）', () => {
    const metrics = drive(staged(1, 'pass'), committed(1, true), staged(2, 'pass'));
    render(<DevtoolsPanel snapshot={metrics.snapshot()} eventLimit={2} />);
    const items = [...document.querySelectorAll('[data-testid="devtools-events"] li')];
    expect(items.map((li) => li.textContent)).toEqual([
      '#3 staged [main] p2 · pass',
      '#2 committed [main] p1 · user-confirmed',
    ]);
  });

  it('多 zone：zones 字典序块 + 全局聚合块并存', () => {
    const metrics = new SessionMetrics();
    metrics.onEvent({ kind: 'staged', zone: 'beta', proposalId: 'p1', seq: 1, verdict: 'pass' });
    metrics.onEvent({ kind: 'staged', zone: 'alpha', proposalId: 'p2', seq: 2, verdict: 'pass' });
    render(<DevtoolsPanel snapshot={metrics.snapshot()} />);
    const zones = [...document.querySelectorAll('section[data-testid^="devtools-zone-"]')].map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(zones).toEqual(['devtools-zone-alpha', 'devtools-zone-beta']); // 字典序
    expect(textOf('devtools-count-proposals')).toBe('proposals 2'); // 全局聚合
    expect(document.querySelector('[data-testid="devtools-global"]')).not.toBeNull();
  });

  it('falseGreenRisk：engagement fail 且回滚率低 → 假绿标记；无回滚证据（null）不标', () => {
    // 2 提案全 autoApplied：交互率 0 → fail；rollbackRate 0 < 0.2 → 假绿
    const falseGreen = drive(staged(1, 'pass'), committed(1, false), staged(2, 'pass'), committed(2, false));
    render(<DevtoolsPanel snapshot={falseGreen.snapshot()} />);
    expect(textOf('devtools-health')).toBe('engagement fail · false-green risk');

    cleanup();
    // 交互率 fail 但无 commit → rollbackRate null = 无回滚证据，不算假绿
    const noEvidence = drive(staged(1, 'pass'), { kind: 'staged-aborted', zone: 'main', proposalId: 'p1', reason: 'user-abort', seq: 2 });
    render(<DevtoolsPanel snapshot={noEvidence.snapshot()} />);
    expect(textOf('devtools-health')).toBe('engagement fail');
  });

  it('surface 上下文：locked/queueFrames/resyncRequired/denied 呈现', () => {
    const metrics = new SessionMetrics();
    render(
      <DevtoolsPanel
        snapshot={metrics.snapshot()}
        surface={{ ...SURFACE, locked: true, queueFrames: 2, resyncRequired: true, denied: { reason: 'blocked', message: 'Proposal blocked by gate' } }}
      />,
    );
    expect(textOf('devtools-surface')).toBe(
      'zone main · locked true · queueFrames 2 · resyncRequired true · denied blocked',
    );
  });

  it('确定性 ×10：同一 snapshot 恒得同一渲染（逐字节）', () => {
    const metrics = drive(staged(1, 'pass'), committed(1, true), staged(2, 'block'));
    const first = renderOnce();
    for (let i = 0; i < 9; i++) {
      expect(renderOnce()).toBe(first);
    }
    function renderOnce(): string {
      const { container } = render(<DevtoolsPanel snapshot={metrics.snapshot()} surface={SURFACE} />);
      const html = container.innerHTML;
      cleanup();
      return html;
    }
  });
});
