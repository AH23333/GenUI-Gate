// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '@genui/proposer-example';
import { LoopBridge } from '../src/bridge';
import { DemoApp } from '../src/DemoApp';

afterEach(cleanup);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function renderDemo(): { bridge: LoopBridge } {
  const loop = new ClosedLoop({ rules: createDemoRules(), surfaceId: DEMO_SURFACE_ID });
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

describe('DemoApp（闭环 demo：提议 → Gate → 预览 → 确认 → 回滚）', () => {
  it('初始空态 + metrics 行（interactionRate 无数据显示 —）', () => {
    renderDemo();
    expect(screen.getByTestId('demo-empty')).toBeTruthy();
    expect(metricsLine()).toBe('proposals 0 · committed 0 · rollbacks 0 · interactionRate —');
  });

  it('提议后：pending-inert 预览 + Pending review 标注 + 确认条，applied 尚未渲染', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    const pending = document.querySelector('[data-genui-pending]');
    expect(pending).not.toBeNull();
    expect(pending?.hasAttribute('inert')).toBe(true);
    expect(screen.getByText('Pending review')).toBeTruthy();
    expect(screen.getByText('Apply')).toBeTruthy();
    expect(screen.getByText('Discard')).toBeTruthy();
    expect(screen.queryByText('Golden Dragon')).not.toBeNull(); // 预览内可见
    expect(document.querySelector('[data-genui-confirm-bar]')).not.toBeNull();
  });

  it('确认（Apply）→ inert 摘除、卡片渲染、metrics 更新', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(screen.getByText('Sushi Kaido')).toBeTruthy();
    expect(metricsLine()).toBe('proposals 1 · committed 1 · rollbacks 0 · interactionRate 1.00');
  });

  it('筛选 chip 增量：Open now 渲染于 Restaurants 之前（DOM 顺序）', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('add-filter-chip');
    clickApply();
    const chip = screen.getByText('Open now');
    const title = screen.getByText('Restaurants');
    expect(chip.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('餐馆详情增量：footer 挂载详情卡', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('show-restaurant-details');
    clickApply();
    expect(screen.getByText('1.2 km')).toBeTruthy();
    expect(screen.getByText('25-35 min')).toBeTruthy();
  });

  it('拒绝（Discard）→ 回到 applied 基线，metrics 不记 commit', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('add-filter-chip');
    fireEvent.click(screen.getByText('Discard'));
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(screen.queryByText('Open now')).toBeNull();
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(metricsLine()).toBe('proposals 2 · committed 1 · rollbacks 0 · interactionRate 0.50');
  });

  it('Revert 逐步回退：chip 回退后列表保留；再回退越界 no-snapshot 静默；interactionRate 可超 1（KAN-029）', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('add-filter-chip');
    clickApply();
    fireEvent.click(document.querySelector('[data-revert]')!);
    expect(screen.queryByText('Open now')).toBeNull();
    expect(screen.getByText('Restaurants')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-revert]')!); // 首次提交前无快照 → 静默
    expect(screen.getByText('Restaurants')).toBeTruthy();
    expect(metricsLine()).toBe('proposals 2 · committed 2 · rollbacks 1 · interactionRate 1.50');
  });

  it('blocked-deep-chain（先建面）→ fallback（data-genui-denied-reason=blocked），applied 保留', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('blocked-deep-chain');
    expect(queryFallbackReason()).toBe('blocked');
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(screen.queryByTestId('demo-empty')).toBeNull();
  });

  it('Lock → 提议被拒（user-lock）→ Unlock 恢复可提议；按钮标签随状态切换', () => {
    const { bridge } = renderDemo();
    fireEvent.click(screen.getByText('Lock zone'));
    expect(document.querySelector('.demo-app')?.getAttribute('data-zone-locked')).toBe('true');
    clickGoal('create-restaurant-list');
    expect(queryFallbackReason()).toBe('user-lock');
    fireEvent.click(screen.getByText('Unlock zone'));
    expect(document.querySelector('.demo-app')?.getAttribute('data-zone-locked')).toBe('false');
    expect(bridge.getSnapshot().denied).not.toBeNull(); // 解锁不清 denied（历史事实）
    clickGoal('create-restaurant-list');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
  });

  it('三态共存：applied（列表）+ staged（chip 预览）同时可见，预览含全量列表', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('add-filter-chip');
    expect(screen.getAllByText('Golden Dragon')).toHaveLength(2); // applied + staged 预览各一份
    const pending = document.querySelector('[data-genui-pending]');
    expect(pending?.contains(screen.getByText('Open now'))).toBe(true);
    expect(metricsLine()).toBe('proposals 2 · committed 1 · rollbacks 0 · interactionRate 0.50');
  });

  it('set-sort-order：dataModel 级提案确认后结构不变（列表仍在）', () => {
    renderDemo();
    clickGoal('create-restaurant-list');
    clickApply();
    clickGoal('set-sort-order');
    clickApply();
    expect(screen.getByText('Golden Dragon')).toBeTruthy();
    expect(metricsLine()).toContain('committed 2');
  });

  it('确定性：同一操作序列 ×10 次渲染结果逐字节一致', () => {
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
      const html = document.body.innerHTML;
      cleanup();
      return html;
    }
  });

  it('空态点 Revert：no-snapshot 静默，空态保持', () => {
    const { bridge } = renderDemo();
    fireEvent.click(document.querySelector('[data-revert]')!);
    expect(screen.getByTestId('demo-empty')).toBeTruthy();
    expect(bridge.getSnapshot().applied).toBeNull();
  });
});
