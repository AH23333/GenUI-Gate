// @vitest-environment jsdom
/**
 * v2 §14 失败矩阵黄金测试 —— React 侧行（M1 任务 1.13，快照级，进 CI）。
 *
 * | v2 §14 行 | M1 落地语义（OSS 口径） | 本文件 |
 * |---|---|---|
 * | gate 任何异常 → GateGuard fail-closed + fallback | evaluate 抛错单帧 quarantine（denied=gate-error），队列继续 | 'gate 行' |
 * | catalog 缺组件 → 提示 | catalog 是宿主配置缺口（gate whitelist 才是合法性权威）→ 跳过子树 + onSkip 审计 | 'catalog 行' |
 * | renderer 非 RenderSource → 拒绝渲染 + 审计事件 | OSS 无独立 RenderSource 签名模块 → 落地为 IrView 形状护栏 + onSkip('invalid-node') 审计 | 'renderer 行' |
 * | pending 帧 verdict block/requireApproval → 移除 + fallback | block → denied fallback（子树不渲染）；requireApproval → 保留 inert 预览待人工确认（§9.2 保守确认优先，「移除」= 移除可交互性） | 'pending 帧 block/requireApproval 行' |
 * | adapter 流损坏 / policy 编译 / snapshot 哈希 / telemetry | 见各包 failure-matrix 文件 | — |
 *
 * 最小混沌注入（§15.5 裁剪版）：gate 行 evaluate 逐帧投毒 property ×100 +
 * GateSurface 挂载混沌序列（判定：宿主零未捕获异常、每次注入必产生可观测 denied、fallback 渲染率 100%）。
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { GateResult, VerdictAction } from '@genui/gate';
import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { ProposalSession } from '@genui/session';
import fc from 'fast-check';
import { GateSurfaceController } from '../src/controller';
import type { SurfaceController, SurfaceState } from '../src/controller';
import { GateSurface } from '../src/GateSurface';
import { IrView } from '../src/IrView';
import type { ComponentCatalog, IrSkipReason } from '../src/IrView';

afterEach(cleanup);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalog: ComponentCatalog = {
  Panel: ({ node, children }) => <div data-testid={`panel-${node.id}`}>{children}</div>,
  Label: ({ node }) => <span data-testid={`label-${node.id}`}>{String(node.props.text ?? '')}</span>,
};

function node(id: string, type = 'Panel', text?: string): IRNode {
  return { id, type, props: text === undefined ? {} : { text }, slots: {} };
}

function mkGate(ir: IRNode, verdict: VerdictAction): GateResult {
  return { ir, verdict, trace: [] };
}

function specEvaluate(payload: JsonValue): GateResult {
  const { n, verdict } = payload as { n: number; verdict: VerdictAction };
  return mkGate(node(`n${n}`), verdict);
}

function frame(n: number, verdict: VerdictAction): JsonObject {
  return { n, verdict };
}

function wired(evaluate: (payload: JsonValue) => GateResult): GateSurfaceController {
  const session = new ProposalSession();
  return new GateSurfaceController({ zone: 'main', session, evaluate });
}

function renderSurface(
  controller: GateSurfaceController,
  onSkip?: (reason: IrSkipReason, node: unknown) => void,
): void {
  render(<GateSurface controller={controller} catalog={catalog} onSkip={onSkip} />);
}

/** 挂载态驱动（act 内同步通知 → React 刷新） */
function drive(controller: GateSurfaceController, n: number, verdict: VerdictAction): void {
  act(() => {
    controller.ingestFrame(frame(n, verdict));
    controller.processQueue();
  });
}

function fallbackReason(): string | null {
  return document.querySelector('[data-genui-fallback]')?.getAttribute('data-genui-denied-reason') ?? null;
}

describe('gate 行：任何异常 → GateGuard fail-closed + fallback（§14）', () => {
  it('黄金快照：evaluate 抛错 → denied=gate-error 精确对象；队列继续（后续好帧正常 stage）', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const controller = wired(boom);
    controller.ingestFrame(frame(1, 'pass'));
    controller.processQueue();
    // 黄金：denied 精确投影（§14 gate 行 fail-closed 语义）
    expect(controller.getSnapshot().denied).toEqual({
      reason: 'gate-error',
      message: 'Gate evaluation failed: boom',
    });
    expect(controller.getSnapshot().queueFrames).toBe(0); // 帧被消费，不阻塞后续
    // 管线不因前帧损坏停摆：新控制器同路径正常 stage
    const next = wired(specEvaluate);
    next.ingestFrame(frame(2, 'pass'));
    next.processQueue();
    expect(next.getSnapshot().staged?.irPrime.id).toBe('n2');
    expect(next.getSnapshot().denied).toBeNull();
  });

  it('挂载黄金：GateSurface 渲染 fallback（role=status + reason=gate-error + 精确文案）', () => {
    const boom = (): never => {
      throw new Error('gate exploded');
    };
    const controller = wired(boom);
    renderSurface(controller);
    drive(controller, 1, 'pass');
    const fallback = document.querySelector('[data-genui-fallback]');
    expect(fallback?.getAttribute('role')).toBe('status');
    expect(fallbackReason()).toBe('gate-error');
    expect(fallback?.textContent).toBe('Gate evaluation failed: gate exploded');
  });

  it('最小混沌注入 ×100：evaluate 逐帧投毒 → 零未捕获、帧全消费、每次注入必有可观测 denied、好帧正常 stage', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<VerdictAction>('pass', 'transform', 'requireApproval', 'block'), {
          minLength: 0,
          maxLength: 12,
        }),
        fc.uniqueArray(fc.nat({ max: 11 }), { maxLength: 6 }),
        (verdicts, poisonCandidate) => {
          const poison = new Set(poisonCandidate.filter((i) => i < verdicts.length));
          let calls = 0;
          const evaluate = (payload: JsonValue): GateResult => {
            calls += 1;
            const { n } = payload as { n: number };
            if (poison.has(n)) {
              throw new Error(`poison ${n}`);
            }
            return specEvaluate(payload);
          };
          const controller = wired(evaluate);
          verdicts.forEach((verdict, i) => {
            controller.ingestFrame(frame(i, verdict));
            controller.processQueue(); // 未捕获异常 = property 失败（零未捕获异常判定）
            const state = controller.getSnapshot();
            expect(state.queueFrames).toBe(0); // 帧全消费，队列不因故障停摆
            if (poison.has(i)) {
              expect(state.denied?.reason).toBe('gate-error'); // quarantine 必发且可观测
              expect(state.denied?.message).toBe(`Gate evaluation failed: poison ${i}`);
            } else if (verdict === 'block') {
              expect(state.denied?.reason).toBe('blocked');
            } else {
              expect(state.staged).not.toBeNull(); // 好帧正常 stage
            }
          });
          expect(calls).toBe(verdicts.length);
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);

  it('挂载混沌序列（确定性）：好帧/毒帧/block/requireApproval 交错 → 宿主零未捕获 + 注入 fallback 渲染率 100%', () => {
    const POISON = -1;
    const seq: ReadonlyArray<VerdictAction | typeof POISON> = ['pass', POISON, 'block', POISON, 'requireApproval', POISON];
    const evaluate = (payload: JsonValue): GateResult => {
      const { n, verdict } = payload as { n: number; verdict: VerdictAction };
      if (n === POISON) {
        throw new Error('poison');
      }
      return specEvaluate(payload);
    };
    const controller = wired(evaluate);
    renderSurface(controller);
    let injections = 0;
    let fallbackRendered = 0;
    seq.forEach((entry, i) => {
      drive(controller, entry === POISON ? POISON : i, entry === POISON ? 'pass' : entry);
      if (entry === POISON) {
        injections += 1;
        expect(fallbackReason()).toBe('gate-error'); // 注入后 fallback 必渲染
        fallbackRendered += 1;
      } else if (entry === 'block') {
        injections += 1;
        expect(fallbackReason()).toBe('blocked');
        fallbackRendered += 1;
      }
    });
    expect(fallbackRendered).toBe(injections); // fallback 渲染率 100%
    // 黄金终态：最后一次是毒帧 → gate-error fallback + 保留的 requireApproval 预览（quarantine 不影响已 staged）
    expect(fallbackReason()).toBe('gate-error');
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull();
    expect(document.querySelector('[data-genui-confirm-bar]')?.getAttribute('data-genui-verdict')).toBe(
      'requireApproval',
    );
  });
});

describe('catalog 行：缺组件 → 跳过子树 + 审计（§14）', () => {
  it('挂载黄金：GateSurface 内未知类型子树跳过，合法兄弟保留，onSkip 审计 catalog-missing', () => {
    const tree: IRNode = {
      id: 'root',
      type: 'Panel',
      props: {},
      slots: {
        default: [
          { id: 'mystery', type: 'Mystery', props: {}, slots: {} },
          { id: 'kept', type: 'Label', props: { text: 'kept' }, slots: {} },
        ],
      },
    };
    const onSkip = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    const controller = wired(() => mkGate(tree, 'pass'));
    renderSurface(controller, onSkip);
    drive(controller, 1, 'pass');
    expect(document.querySelector('[data-testid="label-kept"]')?.textContent).toBe('kept');
    expect(document.querySelector('[data-testid="label-mystery"], [data-testid="panel-mystery"]')).toBeNull();
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith('catalog-missing', expect.objectContaining({ id: 'mystery' }));
  });
});

describe('renderer 行：非 RenderSource 的渲染源 → 拒绝渲染 + 审计（§14）', () => {
  it('挂载黄金：伪造 staged（绕过 gate/session 签发）携带非 IR 形状节点 → 跳过 + 审计 invalid-node + 宿主不崩溃', () => {
    // 伪造渲染源：非正规管线（gate 输出 + session 签发）产出的 staged——renderer 行的威胁模型。
    // session.stage 自身会对含 null 子节点的树在 diff 阶段崩溃（防线在 session 之前），
    // 故以结构化桥对象直接注入，验证渲染器独立防线（fail-closed 形状护栏）。
    const tree = {
      id: 'root',
      type: 'Panel',
      props: {},
      slots: {
        default: [
          { id: 'kept', type: 'Label', props: { text: 'kept' }, slots: {} },
          null,
          { id: 'no-slots', type: 'Label', props: {} },
        ],
      },
    } as unknown as IRNode;
    const forgedStaged = {
      id: 'forged',
      zone: 'main',
      seq: 1,
      irPrime: tree,
      irPrimeHash: 'forged',
      verdict: 'pass',
      trace: [],
      arbitration: { level: 'agent-proposal', decision: 'stage', trace: [] },
      confirmation: 'user-confirm',
      diff: { added: [], removed: [], changed: [], unchangedCount: 0 },
    } as unknown as import('@genui/session').StagedProposal;
    const onSkip = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    // getSnapshot 缓存契约：恒返回同一引用（useSyncExternalStore 硬性要求）
    const snapshot: SurfaceState = {
      zone: 'main',
      applied: null,
      staged: forgedStaged,
      denied: null,
      locked: false,
      queueFrames: 0,
      resyncRequired: false,
    };
    const bridge: SurfaceController = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      confirm: () => ({ status: 'no-staged', proposal: null, supersededId: null }),
      abortPreview: () => ({ status: 'no-staged', abortedId: null }),
    };
    render(<GateSurface controller={bridge} catalog={catalog} onSkip={onSkip} />);
    expect(document.querySelector('[data-testid="label-kept"]')?.textContent).toBe('kept'); // 合法兄弟保留
    expect(document.querySelector('[data-genui-pending]')).not.toBeNull(); // 预览正常挂载
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip).toHaveBeenNthCalledWith(1, 'invalid-node', null);
    expect(onSkip).toHaveBeenNthCalledWith(2, 'invalid-node', expect.objectContaining({ id: 'no-slots' }));
  });

  it('IrView 直挂：根节点非 IR 形状 → 空渲染 + 审计，不崩溃', () => {
    const onSkip = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    const badRoot = { id: 'r', type: 'Panel', props: {} } as unknown as IRNode;
    const { container } = render(<IrView node={badRoot} catalog={catalog} onSkip={onSkip} />);
    expect(container.textContent).toBe('');
    expect(onSkip).toHaveBeenCalledWith('invalid-node', badRoot);
  });
});

describe('pending 帧 block/requireApproval 行（§14）', () => {
  it('block → denied fallback（子树不渲染），黄金投影', () => {
    const controller = wired(specEvaluate);
    renderSurface(controller);
    drive(controller, 1, 'block');
    expect(fallbackReason()).toBe('blocked');
    expect(document.querySelector('[data-genui-pending]')).toBeNull(); // 子树移除（无预览）
    expect(document.querySelector('[data-genui-fallback]')?.textContent).toBe('Proposal blocked by gate');
  });

  it('requireApproval → 保留 inert 预览 + 确认条（§9.2 保守确认优先：「移除」= 移除可交互性）', () => {
    const controller = wired(specEvaluate);
    renderSurface(controller);
    drive(controller, 1, 'requireApproval');
    const pending = document.querySelector('[data-genui-pending]');
    expect(pending).not.toBeNull();
    expect(pending?.hasAttribute('inert')).toBe(true);
    expect(fallbackReason()).toBeNull(); // 非 fallback：预览路径
    expect(document.querySelector('[data-genui-confirm-bar]')?.getAttribute('data-genui-verdict')).toBe(
      'requireApproval',
    );
  });
});
