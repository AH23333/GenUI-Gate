import type { IRNode } from '@genui/ir';

export type Severity = 'info' | 'warn' | 'error' | 'critical';

export type VerdictAction = 'pass' | 'transform' | 'requireApproval' | 'block';

export interface TraceEntry {
  ruleId: string;
  severity: Severity;
  action: VerdictAction;
  nodePath: string;
  message: string;
}

export interface GateResult {
  ir: IRNode;
  verdict: VerdictAction;
  trace: TraceEntry[];
}
