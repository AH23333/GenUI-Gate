// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { IRNode, JsonObject } from '@genui/ir';
import { IrNodesView, IrView } from '../src/IrView';
import type { ComponentCatalog, IrSkipReason } from '../src/IrView';

afterEach(cleanup);

const catalog: ComponentCatalog = {
  Panel: ({ node, children }) => (
    <div data-testid={`panel-${node.id}`}>
      <span data-testid={`panel-type-${node.id}`}>{node.type}</span>
      {children}
    </div>
  ),
  Label: ({ node }) => <span data-testid={`label-${node.id}`}>{String(node.props.text ?? '')}</span>,
};

function n(id: string, type: string, props: JsonObject = {}, slots: Record<string, IRNode[]> = {}): IRNode {
  return { id, type, props, slots };
}

describe('IrView（IR′ → React 渲染）', () => {
  it('渲染根节点：node/props 透传 catalog 组件', () => {
    const tree = n('a', 'Label', { text: 'hello' });
    render(<IrView node={tree} catalog={catalog} />);
    expect(screen.getByTestId('label-a').textContent).toBe('hello');
  });

  it('槽位递归：children 为已渲染的槽位内容', () => {
    const tree = n('p1', 'Panel', {}, {
      default: [n('l1', 'Label', { text: 'one' }), n('l2', 'Label', { text: 'two' })],
    });
    render(<IrView node={tree} catalog={catalog} />);
    const panel = screen.getByTestId('panel-p1');
    expect(panel.querySelector('[data-testid="label-l1"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="label-l2"]')).not.toBeNull();
    // props.type 经 node.type 透传
    expect(screen.getByTestId('panel-type-p1').textContent).toBe('Panel');
  });

  it('多槽位按键插入序渲染', () => {
    const tree = n('p1', 'Panel', {}, {
      second: [n('s1', 'Label', { text: 'S' })],
      first: [n('f1', 'Label', { text: 'F' })],
    });
    render(<IrView node={tree} catalog={catalog} />);
    const order = Array.from(screen.getByTestId('panel-p1').querySelectorAll('[data-testid^="label-"]')).map(
      (element) => element.getAttribute('data-testid'),
    );
    expect(order).toEqual(['label-s1', 'label-f1']);
  });

  it('catalog 缺失类型 → 跳过子树不崩溃（fail-closed，v2 §14）+ onSkip 审计 catalog-missing', () => {
    const tree = n('p1', 'Panel', {}, {
      default: [n('x1', 'Mystery'), n('l1', 'Label', { text: 'kept' })],
    });
    const onSkip = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    render(<IrView node={tree} catalog={catalog} onSkip={onSkip} />);
    expect(screen.getByTestId('label-l1').textContent).toBe('kept');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith('catalog-missing', expect.objectContaining({ id: 'x1', type: 'Mystery' }));
  });

  it('renderer 行（v2 §14）：非 IR 形状渲染源 → 拒绝渲染 + invalid-node 审计 + 宿主不崩溃', () => {
    // 根缺 slots / 槽位内混入非对象 / 槽组非数组
    const badRoot = { id: 'r', type: 'Panel', props: {} } as unknown as IRNode;
    const onSkip = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    const { container } = render(<IrView node={badRoot} catalog={catalog} onSkip={onSkip} />);
    expect(container.textContent).toBe('');
    expect(onSkip).toHaveBeenCalledWith('invalid-node', badRoot);

    cleanup();
    const onSkip2 = vi.fn<(reason: IrSkipReason, node: unknown) => void>();
    const tree = n('p1', 'Panel', {}, {
      default: [n('l1', 'Label', { text: 'kept' }), null as unknown as IRNode, 'garbage' as unknown as IRNode],
    });
    render(<IrView node={tree} catalog={catalog} onSkip={onSkip2} />);
    expect(screen.getByTestId('label-l1').textContent).toBe('kept'); // 合法兄弟保留
    expect(onSkip2).toHaveBeenCalledTimes(2);
    expect(onSkip2).toHaveBeenNthCalledWith(1, 'invalid-node', null);
    expect(onSkip2).toHaveBeenNthCalledWith(2, 'invalid-node', 'garbage');
  });

  it('IrNodesView 脱离 provider 渲染为空（不崩溃）', () => {
    const nodes: IRNode[] = [n('l1', 'Label', { text: 'x' })];
    const { container } = render(<IrNodesView nodes={nodes} />);
    expect(container.textContent).toBe('');
  });
});
