// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { IRNode, JsonObject } from '@genui/ir';
import { IrNodesView, IrView } from '../src/IrView';
import type { ComponentCatalog } from '../src/IrView';

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

  it('catalog 缺失类型 → 跳过子树不崩溃（fail-closed，v2 §14）', () => {
    const tree = n('p1', 'Panel', {}, {
      default: [n('x1', 'Mystery'), n('l1', 'Label', { text: 'kept' })],
    });
    render(<IrView node={tree} catalog={catalog} />);
    expect(screen.getByTestId('label-l1').textContent).toBe('kept');
  });

  it('IrNodesView 脱离 provider 渲染为空（不崩溃）', () => {
    const nodes: IRNode[] = [n('l1', 'Label', { text: 'x' })];
    const { container } = render(<IrNodesView nodes={nodes} />);
    expect(container.textContent).toBe('');
  });
});
