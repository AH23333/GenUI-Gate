// @vitest-environment jsdom
import { act } from 'react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PendingBoundary } from '../src/PendingBoundary';

afterEach(cleanup);

// React 19：显式声明 act 测试环境（RTL 16 不再代设）
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pendingWrapper(): HTMLDivElement {
  const wrapper = document.querySelector<HTMLDivElement>('[data-genui-pending]');
  if (wrapper === null) throw new Error('pending wrapper not found');
  return wrapper;
}

describe('pending 渲染态（v2 §5.2）', () => {
  it('渲染子树 + 默认「待审」标注（英文默认，KAN-014）', () => {
    render(
      <PendingBoundary>
        <p>content</p>
      </PendingBoundary>,
    );
    const wrapper = pendingWrapper();
    expect(wrapper.textContent).toContain('content');
    expect(wrapper.textContent).toContain('Pending review');
    const badge = wrapper.querySelector('[data-genui-pending-badge]');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
  });

  it('自定义标注文案（「待审」由宿主覆盖）', () => {
    render(
      <PendingBoundary badge="待审">
        <p>x</p>
      </PendingBoundary>,
    );
    expect(pendingWrapper().textContent).toContain('待审');
  });

  it('inert 属性 + pointer-events: none', () => {
    render(
      <PendingBoundary>
        <p>x</p>
      </PendingBoundary>,
    );
    const wrapper = pendingWrapper();
    expect(wrapper.hasAttribute('inert')).toBe(true);
    expect(wrapper.style.pointerEvents).toBe('none');
  });

  it('e2e 判定①（§5.2.3）：focus 不进入 pending 子树（activeElement 同步弹出）', () => {
    render(
      <PendingBoundary>
        <button type="button">Go</button>
      </PendingBoundary>,
    );
    const button = screen.getByRole('button');
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(document.body);
    expect(pendingWrapper().contains(document.activeElement)).toBe(false);
  });

  it('e2e 判定②（§5.2.3）：零事件派发（click/keydown/focus handlers 均不触发）', () => {
    const clickSpy = vi.fn();
    const keySpy = vi.fn();
    const focusSpy = vi.fn();
    render(
      <PendingBoundary>
        <button type="button" onClick={clickSpy} onKeyDown={keySpy} onFocus={focusSpy}>
          Go
        </button>
      </PendingBoundary>,
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    act(() => {
      button.focus();
    });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(keySpy).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('对照组：PendingBoundary 之外事件正常派发', () => {
    const clickSpy = vi.fn();
    render(
      <div>
        <button type="button" onClick={clickSpy}>
          Go
        </button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('性质 ×100：任意数量可交互节点全部零派发 + 焦点不进入', () => {
    const prop = fc.property(fc.nat(5), (count) => {
      const spies = Array.from({ length: count + 1 }, () => vi.fn());
      const { container } = render(
        <PendingBoundary>
          {spies.map((spy, index) => (
            <button key={index} type="button" data-testid={`b${index}`} onClick={spy}>
              Go
            </button>
          ))}
        </PendingBoundary>,
      );
      for (let index = 0; index <= count; index += 1) {
        const button = screen.getByTestId(`b${index}`);
        fireEvent.click(button);
        expect(spies[index]).not.toHaveBeenCalled();
        act(() => {
          button.focus();
        });
      }
      expect(container.contains(document.activeElement)).toBe(false);
      cleanup();
    });
    fc.assert(prop, { numRuns: 100 });
  }, 30_000);
});
