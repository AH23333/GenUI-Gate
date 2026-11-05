import { describe, expect, it, vi } from 'vitest';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '@genui/proposer-example';
import { LoopBridge } from '../src/bridge';
import { RESTAURANT_LIST_PARAMS } from '../src/params';

function makeLoop(): ClosedLoop {
  return new ClosedLoop({ rules: createDemoRules(), surfaceId: DEMO_SURFACE_ID });
}

describe('LoopBridge（ClosedLoop → GateSurface 桥）', () => {
  it('getSnapshot 缓存：无变化期间恒返回同一引用', () => {
    const bridge = new LoopBridge(makeLoop());
    expect(bridge.getSnapshot()).toBe(bridge.getSnapshot());
    bridge.unlock(); // 未锁 → no-op
    expect(bridge.getSnapshot()).toBe(bridge.getSnapshot());
  });

  it('propose → 快照更新（staged 非 null）+ 订阅者被通知', () => {
    const bridge = new LoopBridge(makeLoop());
    const listener = vi.fn();
    bridge.subscribe(listener);
    const state = bridge.propose({ ruleId: 'create-restaurant-list', params: RESTAURANT_LIST_PARAMS });
    expect(state.staged).not.toBeNull();
    expect(bridge.getSnapshot().staged).toBe(state.staged);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('无变化不通知：unlock 未锁 / revert 无快照均零 notify', () => {
    const bridge = new LoopBridge(makeLoop());
    const listener = vi.fn();
    bridge.subscribe(listener);
    bridge.unlock();
    bridge.revert(1);
    expect(listener).not.toHaveBeenCalled();
    expect(bridge.revert(1).status).toBe('no-snapshot');
  });

  it('denied 映射：blocked-deep-chain → snapshot.denied.reason === "blocked"（需先建面）', () => {
    const bridge = new LoopBridge(makeLoop());
    bridge.propose({ ruleId: 'create-restaurant-list', params: RESTAURANT_LIST_PARAMS });
    bridge.confirm();
    bridge.propose({ ruleId: 'blocked-deep-chain', params: {} });
    const denied = bridge.getSnapshot().denied;
    expect(denied).not.toBeNull();
    expect(denied?.reason).toBe('blocked');
  });

  it('委托结果透传：confirm/discard/revert 均回传 ClosedLoop 结果', () => {
    const bridge = new LoopBridge(makeLoop());
    expect(bridge.confirm().status).toBe('no-staged');
    bridge.propose({ ruleId: 'create-restaurant-list', params: RESTAURANT_LIST_PARAMS });
    expect(bridge.confirm().status).toBe('committed');
    expect(bridge.getSnapshot().applied).not.toBeNull();
    bridge.propose({ ruleId: 'add-filter-chip', params: { label: 'Open now' } });
    expect(bridge.abortPreview().status).toBe('aborted');
    expect(bridge.getSnapshot().staged).toBeNull();
    expect(bridge.revert(1).status).toBe('no-snapshot'); // 首次提交前无快照可回退
    bridge.propose({ ruleId: 'add-filter-chip', params: { label: 'Open now' } });
    expect(bridge.confirm().status).toBe('committed');
    expect(bridge.revert(1).status).toBe('reverted'); // 回到列表基线
    expect(bridge.getSnapshot().applied).not.toBeNull();
    expect(bridge.getLoop().getCommittedFrames()).toHaveLength(1);
  });
});
