import { useSyncExternalStore } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { VerdictAction } from '@genui/gate';
import type { DeniedState, GateSurfaceController } from './controller';
import { IrView } from './IrView';
import type { ComponentCatalog } from './IrView';
import { PendingBoundary } from './PendingBoundary';

/** fallback 契约（v2 §14）：block / gate 异常 / 用户锁定时的降级渲染 */
export interface FallbackProps {
  readonly zone: string;
  readonly denied: DeniedState;
}

/** 确认条契约：staged 预览之上的可交互操作（渲染于 PendingBoundary 之外） */
export interface ConfirmBarProps {
  readonly zone: string;
  readonly verdict: VerdictAction;
  readonly onConfirm: () => void;
  readonly onAbort: () => void;
}

export interface GateSurfaceProps {
  readonly controller: GateSurfaceController;
  readonly catalog: ComponentCatalog;
  /** 降级渲染组件（默认 role="status" 提示条） */
  readonly fallback?: ComponentType<FallbackProps>;
  /** 确认条组件（默认 Apply/Discard） */
  readonly confirmBar?: ComponentType<ConfirmBarProps>;
  /** 空态（无 applied / staged / denied） */
  readonly empty?: ReactNode;
  /** pending 标注文案，透传 PendingBoundary */
  readonly pendingBadge?: string;
}

export function DefaultFallback({ denied }: FallbackProps): ReactElement {
  return (
    <div role="status" data-genui-fallback="" data-genui-denied-reason={denied.reason}>
      {denied.message}
    </div>
  );
}

export function DefaultConfirmBar({ verdict, onConfirm, onAbort }: ConfirmBarProps): ReactElement {
  return (
    <div data-genui-confirm-bar="" data-genui-verdict={verdict}>
      <button type="button" data-genui-confirm="" onClick={onConfirm}>Apply</button>
      <button type="button" data-genui-abort="" onClick={onAbort}>Discard</button>
    </div>
  );
}

/**
 * 单 zone 渲染面（v2 §5.2 + §14）：
 *
 * - applied：已提交内容，正常交互；
 * - staged：pending-inert 预览（PendingBoundary）+ 确认条——pending 子树内不存在可交互路径；
 * - denied：fallback 降级渲染；
 * - 三者可共存（流式语义：pending 子树与已提交内容并存）。
 */
export function GateSurface({
  controller,
  catalog,
  fallback = DefaultFallback,
  confirmBar = DefaultConfirmBar,
  empty = null,
  pendingBadge,
}: GateSurfaceProps): ReactElement {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const Fallback = fallback;
  const ConfirmBar = confirmBar;
  return (
    <div data-genui-surface="" data-genui-zone={state.zone}>
      {state.applied !== null ? <IrView node={state.applied.irPrime} catalog={catalog} /> : null}
      {state.staged !== null ? (
        <>
          <ConfirmBar
            zone={state.zone}
            verdict={state.staged.verdict}
            onConfirm={() => controller.confirm()}
            onAbort={() => controller.abortPreview()}
          />
          <PendingBoundary badge={pendingBadge}>
            <IrView node={state.staged.irPrime} catalog={catalog} />
          </PendingBoundary>
        </>
      ) : null}
      {state.denied !== null ? <Fallback zone={state.zone} denied={state.denied} /> : null}
      {state.applied === null && state.staged === null && state.denied === null ? empty : null}
    </div>
  );
}
