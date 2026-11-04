import type { IRNode } from '@genui/ir';
import { DEFAULT_BUDGETS, checkBudget, type Budgets } from './budget';
import { applyFixes, type Fixer, type FixRequest } from './fix';
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

/**
 * policy 阶段求值结果（v2 §6.1 级 4）：enforce/shadow 条目 + transform 请求。
 * 由 `@genui/policy` 的 `evaluatePolicy(compiled, ir)` 满足（gate 不依赖 policy 包，
 * 以回调注入保持零依赖，KAN-005）。
 */
export interface PolicyEvaluation {
  entries: TraceEntry[];
  fixRequests: FixRequest[];
}

export type PolicyEvaluator = (ir: IRNode) => PolicyEvaluation;

export interface GateOptions {
  limits?: Partial<Limits>;
  catalog?: Catalog;
  budget?: Partial<Budgets>;
  /** policy 阶段求值器（v2 §6.1 级 4），典型形态 `(ir) => evaluatePolicy(compiled, ir)` */
  policy?: PolicyEvaluator;
  /** 具名修复器表（v2 §6.4/§6.7 fix 阶段）；transform 请求引用的名字缺失时 fail-closed 降级 block */
  fixers?: Readonly<Record<string, Fixer>>;
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
  let workingIr = ir;
  if (options.policy !== undefined) {
    const evaluate = options.policy;
    const evaluation = evaluate(ir);
    trace.push(...evaluation.entries);
    trace.push(...checkBudget(ir, budgets));
    if (evaluation.fixRequests.length > 0) {
      const fixers = options.fixers ?? {};
      const fixResult = applyFixes(workingIr, evaluation.fixRequests, fixers);
      // §6.4 完备性契约运行时复检：fix 后该规则不得再触发，仍触发则禁 transform
      // （降级 error+requireApproval，v2 §6.4「只能降级为 requireApproval/block」）。
      // 不完备修复的效果不得进入返回 IR（否则下一遍 gate 的规则判定漂移，违反 §15.0），
      // 故剔除后以剩余请求重跑 applyFixes；保留请求的完备性已由本次复检验证
      // （fixer 为节点级纯函数，剔除其他修复不影响保留节点的规则判定），不再二次复检。
      const recheck = evaluate(fixResult.ir);
      const stillFiring = new Set<string>();
      for (const entry of recheck.entries) {
        if (entry.shadowAction === undefined) {
          stillFiring.add(`${entry.ruleId}\u0000${entry.nodePath}`);
        }
      }
      const degradedKeys = new Set<string>();
      for (const entry of fixResult.trace) {
        if (entry.action === 'transform' && stillFiring.has(`${entry.ruleId}\u0000${entry.nodePath}`)) {
          degradedKeys.add(`${entry.ruleId}\u0000${entry.nodePath}`);
        }
      }
      if (degradedKeys.size === 0) {
        trace.push(...fixResult.trace);
        workingIr = fixResult.ir;
      } else {
        const keptRequests: FixRequest[] = [];
        for (const request of evaluation.fixRequests) {
          if (!degradedKeys.has(`${request.ruleId}\u0000${request.nodePath}`)) {
            keptRequests.push(request);
          }
        }
        const rerun = applyFixes(workingIr, keptRequests, fixers);
        for (const entry of fixResult.trace) {
          if (degradedKeys.has(`${entry.ruleId}\u0000${entry.nodePath}`)) {
            trace.push({
              ruleId: entry.ruleId,
              severity: 'error',
              action: 'requireApproval',
              nodePath: entry.nodePath,
              message: `${entry.message}; fixer did not resolve the rule, transform degraded to requireApproval (v2 6.4)`,
            });
          }
        }
        trace.push(...rerun.trace);
        workingIr = rerun.ir;
      }
    }
  } else {
    trace.push(...checkBudget(ir, budgets));
  }
  return { ir: workingIr, verdict: aggregate(trace), trace };
}
