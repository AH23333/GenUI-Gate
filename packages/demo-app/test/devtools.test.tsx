// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '@genui/proposer-example';
import type { ProposerRule } from '@genui/proposer-example';
import { LoopBridge } from '../src/bridge';
import { DemoApp } from '../src/DemoApp';

afterEach(cleanup);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** 故障注入规则（gate-error 路径装置，与 proposer-example 测试同形态） */
const GARBAGE_RULE: ProposerRule = {
  id: 'garbage',
  description: 'emits a frame with an unknown message kind (gate-error path)',
  instantiate: () => ({ kind: 'nonsense', payload: {} }) as never,
};

function renderDemo(extraRules: ProposerRule[] = []): { bridge: LoopBridge } {
  const loop = new ClosedLoop({
    rules: [...createDemoRules(DEMO_SURFACE_ID), ...extraRules],
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
  fireEvent.click(document.querySelector('[data-genui-confirm]')!);
}

function textOf(id: string): string {
  return document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
}

function eventLines(): string[] {
  return [...document.querySelectorAll('[data-testid="devtools-events"] li')].map((li) => li.textContent ?? '');
}

describe('DemoApp devtools 面板集成（1.12：本地指标呈现，零网络出口）', () => {
  it('初始：insufficient-data + 空事件列表 + surface 上下文', () => {
    renderDemo();
    expect(textOf('devtools-health')).toBe('engagement insufficient-data');
    expect(eventLines()).toEqual([]);
    expect(textOf('devtools-surface')).toBe('zone main · locked false · queueFrames 0 · resyncRequired false');
  });

  it('提议 → 确认 → 回滚：事件行/计数/比率实时呈现（最新在前）', () => {
    const { bridge } = renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('add-filter-chip');
    clickApply();
    act(() => {
      bridge.revert(1);
    });
    expect(textOf('devtools-count-proposals')).toBe('proposals 2');
    expect(textOf('devtools-count-committed')).toBe('committed 2');
    expect(textOf('devtools-count-rollback')).toBe('rollback 1');
    expect(textOf('devtools-rate-interactionRate')).toBe('interactionRate 1.50'); // >1（KAN-029）
    expect(eventLines()).toEqual([
      '#5 reverted [main] p1 · steps 1',
      '#4 committed [main] p3 · user-confirmed',
      '#3 staged [main] p3 · pass',
      '#2 committed [main] p1 · user-confirmed',
      '#1 staged [main] p1 · pass',
    ]);
  });

  it('staged 期间 surface 行呈现 pending 队列与 zone；discard 后 ignore 分类', () => {
    const { bridge } = renderDemo();
    clickGoal('create-restaurant-list');
    expect(textOf('devtools-surface')).toBe('zone main · locked false · queueFrames 0 · resyncRequired false');
    fireEvent.click(document.querySelector('[data-genui-abort]')!);
    expect(textOf('devtools-count-ignore')).toBe('ignore 1');
    expect(textOf('devtools-health')).toBe('engagement fail'); // 1 提案 0 交互，无 commit → 无假绿标记
    expect(bridge.getSnapshot().staged).toBeNull();
  });

  it('gate-error（garbage 故障注入）不进 session 事件流（stage 前失败），但 surface 行可见 denied', () => {
    const { bridge } = renderDemo([GARBAGE_RULE]);
    clickGoal('create-restaurant-list');
    clickApply();
    act(() => {
      bridge.propose({ ruleId: 'garbage' });
    });
    expect(textOf('devtools-surface')).toContain('denied gate-error');
    expect(eventLines().some((line) => line.includes('gate-error'))).toBe(false); // stage 前失败，metrics 不见
    expect(textOf('devtools-count-proposals')).toBe('proposals 1'); // 计数不涨
  });

  it('lock → zone-locked 事件进 eventLog；unlock 进 eventLog', () => {
    const { bridge } = renderDemo();
    act(() => {
      bridge.lock();
    });
    act(() => {
      bridge.unlock();
    });
    expect(eventLines()).toEqual(['#2 zone-unlocked [main]', '#1 zone-locked [main]']);
  });

  it('确定性 ×10：devtools 面板随同一操作序列逐字节一致', () => {
    const first = runOnce();
    for (let i = 0; i < 9; i++) {
      expect(runOnce()).toBe(first);
    }
    function runOnce(): string {
      const { bridge } = renderDemo();
      clickGoal('create-restaurant-list');
      clickApply();
      clickGoal('show-restaurant-details');
      clickApply();
      act(() => {
        bridge.revert(1);
      });
      const html = document.querySelector('[data-testid="demo-devtools"]')!.innerHTML;
      cleanup();
      return html;
    }
  });
});
