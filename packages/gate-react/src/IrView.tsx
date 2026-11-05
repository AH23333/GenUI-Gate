import { createContext, useContext } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { IRNode } from '@genui/ir';

/** catalog 组件契约：收到 IR 节点 + 已渲染的槽位内容（槽位键插入序、槽内文档序） */
export interface CatalogComponentProps {
  readonly node: IRNode;
  readonly children?: ReactNode;
}

export type ComponentCatalog = Readonly<Record<string, ComponentType<CatalogComponentProps>>>;

export interface IrViewProps {
  readonly node: IRNode;
  readonly catalog: ComponentCatalog;
}

export interface IrNodesViewProps {
  readonly nodes: readonly IRNode[];
}

interface IrContextValue {
  readonly catalog: ComponentCatalog;
}

const IrContext = createContext<IrContextValue | null>(null);

/** IR′ → React 渲染入口（v2 §6.3：渲染器只消费 Gate 产物） */
export function IrView({ node, catalog }: IrViewProps): ReactElement {
  return (
    <IrContext.Provider value={{ catalog }}>
      <IrNodeView node={node} />
    </IrContext.Provider>
  );
}

/** 槽位子树渲染（catalog 组件内可用它渲染具名槽位，catalog 经上下文透传） */
export function IrNodesView({ nodes }: IrNodesViewProps): ReactElement {
  return (
    <>
      {nodes.map((node) => (
        <IrNodeView key={node.id} node={node} />
      ))}
    </>
  );
}

function IrNodeView({ node }: { readonly node: IRNode }): ReactNode {
  const catalog = useContext(IrContext)?.catalog;
  const Component = catalog?.[node.type];
  // fail-closed：gate whitelist 是组件合法性权威；catalog 缺失 = 宿主配置缺口 → 跳过子树不崩溃（v2 §14）
  if (Component === undefined) return null;
  const slotNodes: IRNode[] = Object.values(node.slots).flat();
  const children = slotNodes.length > 0 ? <IrNodesView nodes={slotNodes} /> : undefined;
  return (
    <Component node={node}>
      {children}
    </Component>
  );
}
