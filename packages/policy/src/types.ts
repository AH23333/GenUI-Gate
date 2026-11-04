import type { FixRequest, Severity, TraceEntry, VerdictAction } from '@genui/gate';
import type { IRNode, JsonValue } from '@genui/ir';

/** 规则执行灰度（v2 §7.3）：off 跳过；shadow 只记录不参与聚合；enforce 生效 */
export type RuleMode = 'off' | 'shadow' | 'enforce';

/** 策略分层（v2 §7.1，自底向上单调收紧） */
export type PolicyLayerName = 'baseline' | 'org' | 'app' | 'runtime';

/**
 * 规则匹配条件（纯数据，v2 §7.2）：组件类型 + prop 存在性。
 * 不支持值匹配、不支持正则——需要更强表达力时扩展封闭字段集。
 */
export interface RuleMatch {
  component?: string;
  props?: {
    present?: string[];
    absent?: string[];
  };
}

/** 策略文档：分层规则集（数据，不是代码） */
export interface PolicyDocument {
  baseline?: PolicyRuleData[];
  org?: PolicyRuleData[];
  app?: PolicyRuleData[];
  runtime?: PolicyRuleData[];
}

/** 规则数据模型：封闭字段集（未知字段 = 编译错误，防代码形态注入，v2 §7.2） */
export interface PolicyRuleData {
  id: string;
  match?: RuleMatch;
  check?: string;
  severity: Severity;
  action: VerdictAction;
  mode?: RuleMode;
  fixer?: string;
  message: string;
}

/** 编译期检查谓词（内置具名，v2 §7.2：策略文档永远不可执行任意代码） */
export type Check = (node: IRNode, path: string) => boolean;

export interface CheckRegistry {
  [name: string]: Check;
}

export interface CompiledRule {
  id: string;
  layer: PolicyLayerName;
  matchComponent: string | null;
  presentProps: string[];
  absentProps: string[];
  check: string;
  checkFn: Check;
  severity: Severity;
  action: VerdictAction;
  mode: RuleMode;
  fixer: string | null;
  message: string;
}

/** 编译产物：索引化谓词表（按组件类型分桶，渲染期零解析开销，v2 §7.1） */
export interface CompiledPolicy {
  policyHash: string;
  rules: CompiledRule[];
  buckets: Map<string | null, number[]>;
  checks: CheckRegistry;
}

/** 策略求值输出：trace 条目 + fix 请求（transform 规则，交 gate fix 阶段） */
export interface PolicyEvaluation {
  entries: TraceEntry[];
  fixRequests: FixRequest[];
}

/** 编译错误的机器可读形态（含规则 ID，v2 §7.1：带规则 ID 报错） */
export interface PolicyIssue {
  layer: PolicyLayerName;
  ruleId: string | null;
  message: string;
}

export type { FixRequest, Severity, TraceEntry, VerdictAction };

export type { IRNode, JsonValue };
