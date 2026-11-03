export type ComponentId = string;

export type NodeId = string;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export interface BindingRef {
  source: string;
  path: string;
}

export interface IRNode {
  id: NodeId;
  type: ComponentId;
  props: JsonObject;
  slots: Record<string, IRNode[]>;
  bindings?: BindingRef[];
}

export type IR = IRNode;
