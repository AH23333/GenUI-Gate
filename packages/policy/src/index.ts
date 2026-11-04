export { BUILTIN_CHECKS } from './checks';
export { PolicyCompileError, compilePolicy, type CompilePolicyOptions } from './compile';
export { evaluatePolicy } from './evaluate';
export type {
  Check,
  CheckRegistry,
  CompiledPolicy,
  CompiledRule,
  PolicyDocument,
  PolicyEvaluation,
  PolicyIssue,
  PolicyLayerName,
  PolicyRuleData,
  RuleMatch,
  RuleMode,
} from './types';
