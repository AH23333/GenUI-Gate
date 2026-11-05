import type { ReactElement } from 'react';
import type { CatalogComponentProps, ComponentCatalog } from '@genui/gate-react';

function Column({ node, children }: CatalogComponentProps): ReactElement {
  return (
    <div data-ir-id={node.id} className="demo-column">
      {children}
    </div>
  );
}

function Row({ node, children }: CatalogComponentProps): ReactElement {
  return (
    <div data-ir-id={node.id} className="demo-row">
      {children}
    </div>
  );
}

function Card({ node, children }: CatalogComponentProps): ReactElement {
  return (
    <div data-ir-id={node.id} className="demo-card">
      {children}
    </div>
  );
}

function Text({ node }: CatalogComponentProps): ReactElement {
  const text = typeof node.props.text === 'string' ? node.props.text : '';
  return (
    <span data-ir-id={node.id} className="demo-text">
      {text}
    </span>
  );
}

/** demo 渲染目录：basic catalog 的 Column / Row / Card / Text 映射为简单样式元素 */
export const demoCatalog: ComponentCatalog = {
  Column,
  Row,
  Card,
  Text,
};
