import { createContext, useContext } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { IRNode } from '@genui/ir';

/** catalog 组件契约：收到 IR 节点 + 已渲染的槽位内容（槽位键插入序、槽内文档序） */
export interface CatalogComponentProps {
  readonly node: IRNode;
  readonly children?: ReactNode;
}

export type ComponentCatalog = Readonly<Record<string, ComponentType<CatalogComponentProps>>>;

/**
 * 渲染器跳过原因（v2 §14 catalog/renderer 行审计信号）：
 * - catalog-missing：节点形状合法但组件不在 catalog（宿主配置缺口，gate whitelist 才是合法性权威）
 * - invalid-node：节点不是可渲染的 IR 形状（renderer 行「非 RenderSource 的渲染源」fail-closed 拒绝）
 */
export type IrSkipReason = 'catalog-missing' | 'invalid-node';

export interface IrViewProps {
  readonly node: IRNode;
  readonly catalog: ComponentCatalog;
  /**
   * 渲染器审计回调（v2 §14 拒绝计数/审计事件）：子树被跳过时上报。
   * render 期同步调用（每次渲染都会重放），仅作诊断记录，不应触发状态更新。
   */
  readonly onSkip?: (reason: IrSkipReason, node: unknown) => void;
}

export interface IrNodesViewProps {
  readonly nodes: readonly IRNode[];
}

interface IrContextValue {
  readonly catalog: ComponentCatalog;
  readonly onSkip?: (reason: IrSkipReason, node: unknown) => void;
}

const IrContext = createContext<IrContextValue | null>(null);

/** 可渲染形状护栏（fail-closed）：缺 type/id 或 slots 非对象 → 渲染器拒绝（v2 §14 renderer 行） */
function isRenderableIrNode(node: IRNode): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof node.type === 'string' &&
    node.type !== '' &&
    typeof node.id === 'string' &&
    typeof node.slots === 'object' &&
    node.slots !== null &&
    !Array.isArray(node.slots)
  );
}

/** IR′ → React 渲染入口（v2 §6.3：渲染器只消费 Gate 产物） */
export function IrView({ node, catalog, onSkip }: IrViewProps): ReactElement {
  return (
    <IrContext.Provider value={{ catalog, onSkip }}>
      <IrNodeView node={node} />
    </IrContext.Provider>
  );
}

/** 槽位子树渲染（catalog 组件内可用它渲染具名槽位，catalog 经上下文透传） */
export function IrNodesView({ nodes }: IrNodesViewProps): ReactElement {
  return (
    <>
      {nodes.map((node, index) => (
        <IrNodeView key={isRenderableIrNode(node) ? node.id : `skipped-${index}`} node={node} />
      ))}
    </>
  );
}

function IrNodeView({ node }: { readonly node: IRNode }): ReactNode {
  const ctx = useContext(IrContext);
  // fail-closed（renderer 行）：非 IR 形状的渲染源拒绝渲染，跳过子树不崩溃
  if (!isRenderableIrNode(node)) {
    ctx?.onSkip?.('invalid-node', node);
    return null;
  }
  const Component = ctx?.catalog?.[node.type];
  // fail-closed（catalog 行）：gate whitelist 是组件合法性权威；catalog 缺失 = 宿主配置缺口 → 跳过子树不崩溃（v2 §14）
  if (Component === undefined) {
    ctx?.onSkip?.('catalog-missing', node);
    return null;
  }
  const slotNodes: IRNode[] = [];
  for (const group of Object.values(node.slots)) {
    if (Array.isArray(group)) slotNodes.push(...group);
  }
  const children = slotNodes.length > 0 ? <IrNodesView nodes={slotNodes} /> : undefined;
  return (
    <Component node={node}>
      {children}
    </Component>
  );
}
