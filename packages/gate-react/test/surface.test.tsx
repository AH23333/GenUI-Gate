// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GateResult, VerdictAction } from '@genui/gate';
import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { ProposalSession } from '@genui/session';
import { GateSurface } from '../src/GateSurface';
import { GateSurfaceController } from '../src/controller';
import type { ComponentCatalog } from '../src/IrView';

afterEach(cleanup);

// React 19：显式声明 act 测试环境（RTL 16 不再代设）
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function makeCatalog(onClick: () => void): ComponentCatalog {
  return {
    Panel: ({ node, children }) => <div data-testid={`panel-${node.id}`}>{children}</div>,
    ActionButton: ({ node }) => (
      <button type="button" data-testid={`btn-${node.id}`} onClick={onClick}>
        {String(node.props.label ?? '')}
      </button>
    ),
  };
}

function tree(n: string): IRNode {
  return {
    id: `root-${n}`,
    type: 'Panel',
    props: {},
    slots: { default: [{ id: n, type: 'ActionButton', props: { label: `Go ${n}` }, slots: {} }] },
  };
}

function specEvaluate(payload: JsonValue): GateResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ir: tree('invalid'), verdict: 'block', trace: [] };
  }
  const { n, verdict } = payload;
  if (typeof n !== 'string' || typeof verdict !== 'string') {
    return { ir: tree('invalid'), verdict: 'block', trace: [] };
  }
  if (verdict !== 'pass' && verdict !== 'transform' && verdict !== 'requireApproval' && verdict !== 'block') {
    return { ir: tree('invalid'), verdict: 'block', trace: [] };
  }
  return { ir: tree(n), verdict, trace: [] };
}

function frame(n: string, verdict: VerdictAction): JsonObject {
  return { n, verdict };
}

interface Wired {
  controller: GateSurfaceController;
  onClick: ReturnType<typeof vi.fn>;
}

function wired(autoCommit = false): Wired {
  const session = new ProposalSession();
  const controller = new GateSurfaceController({
    zone: 'main',
    session,
    evaluate: specEvaluate,
    autoCommit,
    arbitration: autoCommit ? { platformPolicy: 'auto' } : undefined,
  });
  const onClick = vi.fn();
  return { controller, onClick };
}

function renderSurface(w: Wired): void {
  render(<GateSurface controller={w.controller} catalog={makeCatalog(w.onClick)} />);
}

function propose(controller: GateSurfaceController, n: string, verdict: VerdictAction = 'pass'): void {
  act(() => {
    controller.ingestFrame(frame(n, verdict));
    controller.processQueue();
  });
}

describe('GateSurface（v2 §5.2 pending-inert + §14 fallback）', () => {
  it('空态：仅 surface 容器 + 自定义空态渲染', () => {
    const { controller } = wired();
    render(
      <GateSurface controller={controller} catalog={makeCatalog(vi.fn())} empty={<p>nothing</p>} />,
    );
    expect(screen.getByText('nothing')).toBeTruthy();
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(document.querySelector('[data-genui-fallback]')).toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')).toBeNull();
  });

  it('staged = pending-inert 预览 + 确认条（默认文案）', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')).not.toBeNull();
    expect(screen.getByText('Pending review')).toBeTruthy();
    expect(screen.getByTestId('btn-1')).toBeTruthy();
    expect(screen.getByText('Apply')).toBeTruthy();
    expect(screen.getByText('Discard')).toBeTruthy();
  });

  it('e2e 判定（§5.2.3）：pending 期间零事件派发 + activeElement 不进入 pending 子树', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    const button = screen.getByTestId('btn-1');
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(button);
    expect(w.onClick).not.toHaveBeenCalled();
  });

  it('确认（Apply）→ inert 摘除、恢复交互', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    fireEvent.click(screen.getByText('Apply'));
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')).toBeNull();
    const button = screen.getByTestId('btn-1');
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(w.onClick).toHaveBeenCalledTimes(1);
  });

  it('拒绝（Discard）→ 回到空态', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    fireEvent.click(screen.getByText('Discard'));
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(screen.queryByTestId('btn-1')).toBeNull();
  });

  it('block → fallback（§14，role=status + reason）', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1', 'block');
    const fallback = document.querySelector('[data-genui-fallback]');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('role')).toBe('status');
    expect(fallback?.getAttribute('data-genui-denied-reason')).toBe('blocked');
    expect(fallback?.textContent).toContain('Proposal blocked by gate');
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
  });

  it('gate 异常 → fallback reason=gate-error', () => {
    const session = new ProposalSession();
    const controller = new GateSurfaceController({
      zone: 'main',
      session,
      evaluate: (): GateResult => {
        throw new Error('kaboom');
      },
    });
    const onClick = vi.fn();
    render(<GateSurface controller={controller} catalog={makeCatalog(onClick)} />);
    propose(controller, '1');
    const fallback = document.querySelector('[data-genui-fallback]');
    expect(fallback?.getAttribute('data-genui-denied-reason')).toBe('gate-error');
    expect(fallback?.textContent).toContain('kaboom');
  });

  it('自定义 fallback 组件', () => {
    const w = wired();
    render(
      <GateSurface
        controller={w.controller}
        catalog={makeCatalog(w.onClick)}
        fallback={({ denied }) => <mark data-testid="custom-fallback">{denied.reason}</mark>}
      />,
    );
    propose(w.controller, '1', 'block');
    expect(screen.getByTestId('custom-fallback').textContent).toBe('blocked');
  });

  it('applied 与 staged 共存：已提交可交互，pending 预览不可交互', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    fireEvent.click(screen.getByText('Apply'));
    propose(w.controller, '2');
    fireEvent.click(screen.getByTestId('btn-1'));
    expect(w.onClick).toHaveBeenCalledTimes(1);
    const pending = document.querySelector('[data-genui-pending]');
    expect(pending).not.toBeNull();
    expect(pending?.contains(screen.getByTestId('btn-2'))).toBe(true);
    fireEvent.click(screen.getByTestId('btn-2'));
    expect(w.onClick).toHaveBeenCalledTimes(1);
  });

  it('revert 恢复上一版渲染', () => {
    const w = wired();
    renderSurface(w);
    propose(w.controller, '1');
    fireEvent.click(screen.getByText('Apply'));
    propose(w.controller, '2');
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByTestId('btn-2')).toBeTruthy();
    act(() => {
      w.controller.revert(1);
    });
    expect(screen.queryByTestId('btn-2')).toBeNull();
    expect(screen.getByTestId('btn-1')).toBeTruthy();
  });

  it('autoCommit：pass 帧边界直接应用（v2 §5.2 摘除 inert）', () => {
    const w = wired(true);
    renderSurface(w);
    propose(w.controller, '1');
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')).toBeNull();
    expect(screen.getByTestId('btn-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('btn-1'));
    expect(w.onClick).toHaveBeenCalledTimes(1);
  });

  it('autoCommit + requireApproval：仍需人工确认', () => {
    const w = wired(true);
    renderSurface(w);
    propose(w.controller, '1', 'requireApproval');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')).not.toBeNull();
    fireEvent.click(screen.getByText('Apply'));
    expect(document.querySelector('[data-genui-pending]')).toBeNull();
    expect(screen.getByTestId('btn-1')).toBeTruthy();
  });
});
