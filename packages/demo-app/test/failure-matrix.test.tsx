// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '@genui/proposer-example';
import type { ProposerRule } from '@genui/proposer-example';
import { LoopBridge } from '../src/bridge';
import { DemoApp } from '../src/DemoApp';

/**
 * 失败矩阵黄金测试（v2 §14，demo-app 包，全栈 UI）——每行一个黄金断言组，快照级进 CI。
 *
 * §14 行 → demo-app 全栈落地映射（M1）：
 * - 「gate 异常」行 → garbage 规则注入（未知 kind，TD-004）：帧在 stage 前失败 →
 *   UI fallback（data-genui-denied-reason=gate-error）+ applied 保留 + devtools surface 行可观测
 *   「denied gate-error」。gate-error 不进 session 事件流：eventLog 无新增条目、counts 不涨
 *   （与 blocked/user-lock 行形成对照）。
 * - 「pending 帧 block」行 → blocked-deep-chain 全栈黄金（fallback blocked + applied 保留）；
 *   user-lock 行同批覆盖。
 * - 「telemetry 上报失败」行 → 零网络出口 canary（v3 §11）：全交互脚本（含全部故障路径）期间
 *   fetch / XMLHttpRequest / sendBeacon 零调用——本地指标无上报通道，「上报失败」结构性不可发生。
 */

afterEach(cleanup);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** 故障注入规则：garbage 走 gate-error（与 loop.test SPECIAL_RULES[0] 同款） */
type RuleFrame = ReturnType<ProposerRule['instantiate']>;
const GARBAGE_RULE: ProposerRule = {
  id: 'garbage',
  description: 'emits a frame with an unknown message kind (gate-error path)',
  instantiate: () => ({ kind: 'nonsense', payload: {} }) as unknown as RuleFrame,
};

function renderMatrix(): { bridge: LoopBridge } {
  const loop = new ClosedLoop({
    rules: [GARBAGE_RULE, ...createDemoRules(DEMO_SURFACE_ID)],
    surfaceId: DEMO_SURFACE_ID,
  });
  const bridge = new LoopBridge(loop);
  render(<DemoApp bridge={bridge} />);
  return { bridge };
}

function clickGoal(key: string): void {
  fireEvent.click(document.querySelector(`[data-goal="${key}"]`)!);
}

function clickApply(): void {
  fireEvent.click(screen.getByText('Apply'));
}

function metricsLine(): string {
  return screen.getByTestId('metrics-line').textContent ?? '';
}

function queryFallbackReason(): string | null {
  return document.querySelector('[data-genui-fallback]')?.getAttribute('data-genui-denied-reason') ?? null;
}

function devtoolsEventCount(): number {
  return document.querySelectorAll('[data-testid="devtools-events"] li').length;
}

describe('gate 行（garbage 注入）：全栈 UI fail-closed（§14）', () => {
  it('黄金快照：已 applied 基线上 garbage 提议 → fallback gate-error + applied 保留 + devtools 可观测 + 事件流/计数零污染', () => {
    const { bridge } = renderMatrix();
    clickGoal('create-restaurant-list');
    clickApply();
    const eventsBefore = devtoolsEventCount();
    expect(metricsLine()).toBe('proposals 1 · committed 1 · rollbacks 0 · interactionRate 1.00');

    act(() => {
      bridge.propose({ ruleId: 'garbage' });
    });

    // UI fallback 精确（role=status + reason + 消息文案）
    expect(queryFallbackReason()).toBe('gate-error');
    expect(screen.getByText('frame is not a valid A2UI message')).toBeTruthy();
    // applied 保留：基线卡片仍在，不回退空态
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(screen.queryByTestId('demo-empty')).toBeNull();
    // devtools surface 行可观测 denied gate-error（gate-error 的唯一事件出口）
    expect(screen.getByTestId('devtools-surface').textContent).toContain('denied gate-error');
    // gate-error 不进 session 事件流：eventLog 无新增、counts 不涨（KAN-031 口径）
    expect(devtoolsEventCount()).toBe(eventsBefore);
    expect(metricsLine()).toBe('proposals 1 · committed 1 · rollbacks 0 · interactionRate 1.00');

    // fail-closed 不 fail-dead：故障后正常提案全生命周期可用
    clickGoal('add-filter-chip');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
    clickApply();
    expect(screen.getByText('Open now')).toBeTruthy();
    expect(metricsLine()).toBe('proposals 2 · committed 2 · rollbacks 0 · interactionRate 1.00');
  });
});

describe('pending 行：block / user-lock 全栈黄金（§14/§9.2）', () => {
  it('blocked-deep-chain → fallback blocked + applied 保留 + deniedBlocked 计数', () => {
    renderMatrix();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('blocked-deep-chain');
    expect(queryFallbackReason()).toBe('blocked');
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    // blocked 走 session 事件流（stage-denied）：与 gate-error 形成对照
    expect(screen.getByTestId('devtools-count-deniedBlocked').textContent).toBe('denied-blocked 1');
  });

  it('user-lock → fallback user-lock；解锁后恢复可提议', () => {
    renderMatrix();
    clickGoal('create-restaurant-list');
    clickApply();
    fireEvent.click(screen.getByText('Lock zone'));
    clickGoal('add-filter-chip');
    expect(queryFallbackReason()).toBe('user-lock');
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(screen.getByTestId('devtools-count-deniedUserLock').textContent).toBe('denied-user-lock 1');
    fireEvent.click(screen.getByText('Unlock zone'));
    clickGoal('add-filter-chip');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
  });
});

describe('telemetry 行：零网络出口 canary（§14 重释，v3 §11）', () => {
  it('全交互脚本（含故障路径）期间 fetch / XMLHttpRequest / sendBeacon 零调用', () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const OriginalXHR = globalThis.XMLHttpRequest;
    const originalBeacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(`fetch:${String(args[0])}`);
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    class RecordingXHR {
      open(...args: unknown[]): void {
        calls.push(`xhr-open:${args.join(',')}`);
      }
      send(...args: unknown[]): void {
        calls.push(`xhr-send:${args.join(',')}`);
      }
    }
    globalThis.XMLHttpRequest = RecordingXHR as unknown as typeof XMLHttpRequest;
    if (globalThis.navigator !== undefined) {
      Object.defineProperty(globalThis.navigator, 'sendBeacon', {
        value: (...args: unknown[]) => {
          calls.push(`beacon:${String(args[0])}`);
          return true;
        },
        configurable: true,
      });
    }

    try {
      const { bridge } = renderMatrix();
      // 覆盖全部路径：正常提案/确认/拒绝/回滚/锁/故障
      clickGoal('create-restaurant-list');
      clickApply();
      clickGoal('add-filter-chip');
      clickApply();
      clickGoal('show-restaurant-details');
      fireEvent.click(screen.getByText('Discard'));
      fireEvent.click(document.querySelector('[data-revert]')!);
      fireEvent.click(screen.getByText('Lock zone'));
      fireEvent.click(screen.getByText('Unlock zone'));
      clickGoal('blocked-deep-chain');
      act(() => {
        bridge.propose({ ruleId: 'garbage' });
      });
      expect(screen.getByTestId('devtools-surface').textContent).toContain('denied gate-error');
      // 全脚本跑完：零网络出口
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = OriginalXHR;
      if (globalThis.navigator !== undefined) {
        Object.defineProperty(globalThis.navigator, 'sendBeacon', {
          ...(originalBeacon === undefined ? {} : { value: originalBeacon }),
          configurable: true,
        });
      }
    }
  });
});
