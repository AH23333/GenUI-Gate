import type { IRNode } from '@genui/ir';
import { DEFAULT_LIMITS, checkLimits, type Limits } from './limits';
import type { GateResult, TraceEntry, VerdictAction } from './types';

const ACTION_RANK: Record<VerdictAction, number> = {
  pass: 0,
  transform: 1,
  requireApproval: 2,
  block: 3,
};

export function aggregate(trace: TraceEntry[]): VerdictAction {
  let verdict: VerdictAction = 'pass';
  for (const entry of trace) {
    if (ACTION_RANK[entry.action] > ACTION_RANK[verdict]) {
      verdict = entry.action;
    }
  }
  return verdict;
}

export interface GateOptions {
  limits?: Partial<Limits>;
}

export function gate(ir: IRNode, options: GateOptions = {}): GateResult {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const trace: TraceEntry[] = checkLimits(ir, limits);
  return { ir, verdict: aggregate(trace), trace };
}
