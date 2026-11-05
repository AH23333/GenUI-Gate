import { useRef } from 'react';
import type { FocusEvent, ReactElement, ReactNode, SyntheticEvent } from 'react';

export interface PendingBoundaryProps {
  readonly children: ReactNode;
  /** 视觉标注文案（v2 §5.2「待审」标注）；默认 'Pending review'（公开物料英文，宿主可覆盖） */
  readonly badge?: string;
}

/** capture 段拦截：pending 子树内的 React 事件不抵达目标 handlers（零事件派发） */
function swallow(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * pending 帧强制 inert 容器（v2 §5.2 修订机制）：
 *
 * - `inert` 属性 + `pointer-events: none` + 「待审」标注——真实浏览器的完整强制；
 * - capture 段事件拦截 + 焦点同步弹出守卫——inert 行为缺失环境（jsdom）的确定性兜底：
 *   focus 落入 pending 子树时同步 blur，`document.activeElement` 不停留在 pending 子树；
 * - e2e 判定（v2 §5.2.3）：pending 期间 activeElement 不进入 pending 子树、零事件派发。
 */
export function PendingBoundary({ children, badge = 'Pending review' }: PendingBoundaryProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // focus 事件不可取消：拦截派发 + 同步把焦点弹出 pending 子树
  const guardFocus = (event: FocusEvent): void => {
    event.stopPropagation();
    const container = containerRef.current;
    if (container === null) return;
    const active = container.ownerDocument.activeElement;
    if (active instanceof HTMLElement && container.contains(active)) {
      active.blur();
    }
  };

  return (
    <div
      ref={containerRef}
      data-genui-pending=""
      inert={true}
      style={{ pointerEvents: 'none' }}
      onClickCapture={swallow}
      onDoubleClickCapture={swallow}
      onMouseDownCapture={swallow}
      onMouseUpCapture={swallow}
      onKeyDownCapture={swallow}
      onKeyUpCapture={swallow}
      onInputCapture={swallow}
      onChangeCapture={swallow}
      onSubmitCapture={swallow}
      onFocusCapture={guardFocus}
    >
      {children}
      <span data-genui-pending-badge="" aria-hidden="true">{badge}</span>
    </div>
  );
}
