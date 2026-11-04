import type { IRNode } from '@genui/ir';
import { DEFAULT_BUDGETS, checkBudget, type Budgets } from './budget';
import { DEFAULT_LIMITS, checkLimits, type Limits } from './limits';
import { checkSchema, validateCatalog, type Catalog } from './schema';
import type { GateResult, Severity, TraceEntry, VerdictAction } from './types';
import { checkWhitelist } from './whitelist';

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

const LEGAL_COMBOS: Record<Severity, ReadonlySet<VerdictAction>> = {
  info: new Set<VerdictAction>(['pass']),
  warn: new Set<VerdictAction>(['pass', 'transform', 'requireApproval']),
  error: new Set<VerdictAction>(['transform', 'requireApproval', 'block']),
  critical: new Set<VerdictAction>(['block']),
};

export function isValidVerdictCombo(severity: Severity, action: VerdictAction): boolean {
  return LEGAL_COMBOS[severity].has(action);
}

export function projectVerdict(action: VerdictAction): VerdictAction {
  return action === 'transform' ? 'pass' : action;
}

export interface GateOptions {
  limits?: Partial<Limits>;
  catalog?: Catalog;
  budget?: Partial<Budgets>;
}

export function gate(ir: IRNode, options: GateOptions = {}): GateResult {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...options.budget };
  const trace: TraceEntry[] = checkLimits(ir, limits);
  if (options.catalog !== undefined) {
    validateCatalog(options.catalog);
    trace.push(...checkSchema(ir, options.catalog));
    trace.push(...checkWhitelist(ir, options.catalog));
  }
  trace.push(...checkBudget(ir, budgets));
  return { ir, verdict: aggregate(trace), trace };
}
