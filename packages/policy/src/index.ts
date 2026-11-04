export {
  BUILTIN_CHECKS,
  LANDMARK_ROLES,
  isInteractiveNode,
  isLandmarkNode,
  parseHeadingLevel,
} from './checks';
export { PolicyCompileError, compilePolicy, type CompilePolicyOptions } from './compile';
export { computeTreeContext, evaluatePolicy } from './evaluate';
export { BASELINE_A11Y } from './preset';
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
  TreeContext,
} from './types';
