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
  /** shadow 模式记录专用（v2 §7.3）：enforce 时本应触发的 action；此时 action 固定为 'pass'，不参与聚合 */
  shadowAction?: VerdictAction;
}

export interface GateResult {
  ir: IRNode;
  verdict: VerdictAction;
  trace: TraceEntry[];
}
