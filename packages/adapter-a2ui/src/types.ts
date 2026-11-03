import type { IRNode } from '@genui/ir';

export type A2UIMessageKind =
  | 'createSurface'
  | 'updateComponents'
  | 'updateDataModel'
  | 'deleteSurface'
  | 'callRendererFunction'
  | 'agentFunctionResponse';

export interface A2UIMessage {
  kind: A2UIMessageKind;
  payload: Record<string, unknown>;
  version?: string;
  messageIndex?: number;
}

export type AdapterIssueCode =
  | 'parse-error'
  | 'unknown-message-kind'
  | 'duplicate-message-key'
  | 'unexpected-envelope-key'
  | 'invalid-message-payload'
  | 'invalid-surface-id'
  | 'invalid-components'
  | 'invalid-data-model'
  | 'surface-already-exists'
  | 'unknown-surface'
  | 'duplicate-component-id'
  | 'missing-component-id'
  | 'missing-component-type'
  | 'missing-root'
  | 'dangling-child-ref'
  | 'child-cycle'
  | 'invalid-child-ref';

export interface AdapterIssue {
  code: AdapterIssueCode;
  message: string;
  surfaceId?: string;
  componentId?: string;
  messageIndex?: number;
}

export interface SurfaceSnapshot {
  surfaceId: string;
  catalogId?: string;
  versions: string[];
  dataModel: Record<string, unknown>;
  ir: IRNode | null;
  deleted: boolean;
  componentCount: number;
}

export interface AdapterResult {
  surfaces: SurfaceSnapshot[];
  issues: AdapterIssue[];
}
