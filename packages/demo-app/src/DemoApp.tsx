import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { GateSurface } from '@genui/gate-react';
import type { LoopBridge } from './bridge';
import { demoCatalog } from './catalog';
import { DEMO_GOALS } from './params';

function formatRate(rate: number | null): string {
  return rate === null ? '—' : rate.toFixed(2);
}

export interface DemoAppProps {
  /** 闭环桥（GateSurface 结构化控制器 + 提议入口） */
  readonly bridge: LoopBridge;
}

/**
 * 闭环 demo 主界面（v3 §6-M1）：
 *
 * - header：标题 + metrics 一行（proposals / committed / rollbacks / interactionRate）；
 * - 左栏：5 个确定性 goal 提议按钮 + zone Lock/Unlock 切换；
 * - 主区：`GateSurface`（pending-inert 预览 + Apply/Discard + fallback + 空态）+ Revert 按钮；
 * - metrics 行在渲染体由 `bridge.getLoop().metrics.snapshot()` 派生——
 *   所有影响 counts 的 session 事件必伴 SurfaceState 变化（同步经 sync() 通知重渲染）。
 */
export function DemoApp({ bridge }: DemoAppProps): ReactElement {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
  const report = bridge.getLoop().metrics.snapshot().global;
  return (
    <div className="demo-app" data-zone-locked={state.locked ? 'true' : 'false'}>
      <header className="demo-header">
        <h1>GenUI Gate — closed-loop demo</h1>
        <p className="demo-metrics" data-testid="metrics-line">
          proposals {report.counts.proposals} · committed {report.counts.committed} · rollbacks{' '}
          {report.counts.rollback} · interactionRate {formatRate(report.rates.interactionRate)}
        </p>
      </header>
      <div className="demo-body">
        <nav className="demo-goals">
          {DEMO_GOALS.map((demoGoal) => (
            <button
              key={demoGoal.key}
              type="button"
              data-goal={demoGoal.key}
              onClick={() => bridge.propose(demoGoal.goal)}
            >
              {demoGoal.label}
            </button>
          ))}
          <button
            type="button"
            data-lock-toggle=""
            onClick={() => (state.locked ? bridge.unlock() : bridge.lock())}
          >
            {state.locked ? 'Unlock zone' : 'Lock zone'}
          </button>
        </nav>
        <main className="demo-main">
          <GateSurface
            controller={bridge}
            catalog={demoCatalog}
            pendingBadge="Pending review"
            empty={<p data-testid="demo-empty">No proposal yet — pick a goal on the left.</p>}
          />
          <button type="button" data-revert="" onClick={() => bridge.revert(1)}>
            Revert last commit
          </button>
        </main>
      </div>
    </div>
  );
}
