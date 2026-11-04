import type { IRNode, JsonValue } from '@genui/ir';

export type Severity = 'info' | 'warn' | 'error' | 'critical';

export type VerdictAction = 'pass' | 'transform' | 'requireApproval' | 'block';

export interface TraceEntry {
  ruleId: string;
  severity: Severity;
  action: VerdictAction;
  nodePath: string;
  message: string;
  /** fix 阶段专用：修改前后的值快照（v2 §6.3） */
  before?: JsonValue;
  after?: JsonValue;
}

export interface GateResult {
  ir: IRNode;
  verdict: VerdictAction;
  trace: TraceEntry[];
}
