import type { SurfaceController, SurfaceState } from '@genui/gate-react';
import type { ClosedLoop, ClosedLoopState, ProposerGoal } from '@genui/proposer-example';
import type { AbortResult, CommitResult, RevertResult } from '@genui/session';

function sameSurfaceState(a: SurfaceState, b: SurfaceState): boolean {
  return (
    a.zone === b.zone &&
    a.applied === b.applied &&
    a.staged === b.staged &&
    a.denied === b.denied &&
    a.locked === b.locked &&
    a.queueFrames === b.queueFrames &&
    a.resyncRequired === b.resyncRequired
  );
}

/**
 * `ClosedLoop` → `GateSurface` 桥（1.11 demo app，v3 §6-M1）：
 *
 * - 把 `ClosedLoopState` 字段级映射为 `SurfaceState`（仅丢弃 surfaceId——渲染面不需要）；
 * - `getSnapshot` 缓存：状态不变期间恒返回同一引用（useSyncExternalStore 硬性要求）；
 * - 字段比对决定通知——无变化不 notify（unlock 未锁、revert 无快照等 no-op 路径）；
 * - 交互方法全部委托 ClosedLoop 并回传结果（metrics 事件由 loop 内部 onEvent 直达 SessionMetrics）。
 */
export class LoopBridge implements SurfaceController {
  private readonly loop: ClosedLoop;
  private readonly listeners = new Set<() => void>();
  private snapshot: SurfaceState;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SurfaceState => {
    return this.snapshot;
  };

  constructor(loop: ClosedLoop) {
    if (typeof loop !== 'object' || loop === null) {
      throw new TypeError('loop must be a ClosedLoop');
    }
    if (
      typeof loop.propose !== 'function' ||
      typeof loop.confirm !== 'function' ||
      typeof loop.discard !== 'function' ||
      typeof loop.state !== 'function'
    ) {
      throw new TypeError('loop must be a ClosedLoop');
    }
    this.loop = loop;
    this.snapshot = this.mapState(loop.state());
  }

  /** 被桥接的闭环（DemoApp 渲染体经此读 metrics） */
  getLoop(): ClosedLoop {
    return this.loop;
  }

  /** 提议一帧（goal 确定性：同 goal 恒同一帧） */
  propose(goal: ProposerGoal): ClosedLoopState {
    const state = this.loop.propose(goal);
    this.sync();
    return state;
  }

  confirm(): CommitResult {
    const result = this.loop.confirm();
    this.sync();
    return result;
  }

  abortPreview(): AbortResult {
    const result = this.loop.discard();
    this.sync();
    return result;
  }

  revert(steps = 1): RevertResult {
    const result = this.loop.revert(steps);
    this.sync();
    return result;
  }

  lock(): void {
    this.loop.lock();
    this.sync();
  }

  unlock(): void {
    this.loop.unlock();
    this.sync();
  }

  private mapState(state: ClosedLoopState): SurfaceState {
    return {
      zone: state.zone,
      applied: state.applied,
      staged: state.staged,
      denied: state.denied,
      locked: state.locked,
      queueFrames: state.queueFrames,
      resyncRequired: state.resyncRequired,
    };
  }

  private sync(): void {
    const next = this.mapState(this.loop.state());
    if (sameSurfaceState(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
