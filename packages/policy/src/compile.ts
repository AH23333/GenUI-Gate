import { isValidVerdictCombo } from '@genui/gate';
import type { Severity, VerdictAction } from '@genui/gate';
import { canonicalHash } from '@genui/ir';
import type { JsonValue } from '@genui/ir';
import { BUILTIN_CHECKS } from './checks';
import type {
  CheckRegistry,
  CompiledPolicy,
  CompiledRule,
  PolicyDocument,
  PolicyIssue,
  PolicyLayerName,
  PolicyRuleData,
  RuleMode,
} from './types';

const ACTION_RANK: Record<VerdictAction, number> = {
  pass: 0,
  transform: 1,
  requireApproval: 2,
  block: 3,
};

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

const MODE_RANK: Record<RuleMode, number> = {
  off: 0,
  shadow: 1,
  enforce: 2,
};

const LAYER_ORDER: PolicyLayerName[] = ['baseline', 'org', 'app', 'runtime'];

const RULE_FIELDS = new Set(['id', 'match', 'check', 'severity', 'action', 'mode', 'fixer', 'message']);
const MATCH_FIELDS = new Set(['component', 'props']);
const PROPS_FIELDS = new Set(['present', 'absent']);

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** 编译错误（fail-closed：收集全部 issue 后抛出，gate 不吞） */
export class PolicyCompileError extends Error {
  readonly issues: readonly PolicyIssue[];

  constructor(issues: readonly PolicyIssue[]) {
    super(`policy compilation failed with ${issues.length} issue(s):\n${issues.map((issue) => `  [${issue.layer}${issue.ruleId === null ? '' : `/${issue.ruleId}`}] ${issue.message}`).join('\n')}`);
    this.name = 'PolicyCompileError';
    this.issues = issues;
  }
}

interface Collector {
  issues: PolicyIssue[];
  add(layer: PolicyLayerName, ruleId: string | null, message: string): void;
}

function makeCollector(): Collector {
  const issues: PolicyIssue[] = [];
  return {
    issues,
    add(layer: PolicyLayerName, ruleId: string | null, message: string): void {
      issues.push({ layer, ruleId, message });
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateName(value: unknown, what: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !NAME_PATTERN.test(value)) {
    return `${what} must be a non-empty identifier (letters, digits, _, -, <= 64 chars)`;
  }
  return null;
}

function validateStringArray(value: unknown, what: string, errors: string[]): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${what} must be an array of prop names`);
    return null;
  }
  const names: string[] = [];
  for (const item of value) {
    const error = validateName(item, `${what} entry`);
    if (error !== null) {
      errors.push(error);
      return null;
    }
    names.push(item as string);
  }
  return names;
}

interface ValidatedMatch {
  component: string | null;
  present: string[];
  absent: string[];
}

function validateMatch(layer: PolicyLayerName, ruleId: string, value: unknown, collector: Collector): ValidatedMatch | null {
  if (value === undefined) return { component: null, present: [], absent: [] };
  if (!isObject(value)) {
    collector.add(layer, ruleId, 'match must be an object');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!MATCH_FIELDS.has(key)) {
      collector.add(layer, ruleId, `match has unknown field "${key}" (closed set: component, props)`);
    }
  }
  let component: string | null = null;
  if (value['component'] !== undefined) {
    const error = validateName(value['component'], 'match.component');
    if (error !== null) {
      collector.add(layer, ruleId, error);
      return null;
    }
    component = value['component'] as string;
  }
  let present: string[] = [];
  let absent: string[] = [];
  if (value['props'] !== undefined) {
    if (!isObject(value['props'])) {
      collector.add(layer, ruleId, 'match.props must be an object');
      return null;
    }
    for (const key of Object.keys(value['props'])) {
      if (!PROPS_FIELDS.has(key)) {
        collector.add(layer, ruleId, `match.props has unknown field "${key}" (closed set: present, absent)`);
      }
    }
    const errors: string[] = [];
    const presentResult = validateStringArray(value['props']['present'], 'match.props.present', errors);
    const absentResult = validateStringArray(value['props']['absent'], 'match.props.absent', errors);
    if (presentResult === null || absentResult === null) {
      for (const message of errors) collector.add(layer, ruleId, message);
      return null;
    }
    present = presentResult;
    absent = absentResult;
  }
  return { component, present, absent };
}

function validateRule(layer: PolicyLayerName, value: unknown, collector: Collector): CompiledRule | null {
  if (!isObject(value)) {
    collector.add(layer, null, 'rule must be an object');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!RULE_FIELDS.has(key)) {
      collector.add(layer, null, `rule has unknown field "${key}" (closed field set, v2 7.2: policy documents are data, not code)`);
    }
  }
  const idError = validateName(value['id'], 'rule.id');
  if (idError !== null) {
    collector.add(layer, null, idError);
    return null;
  }
  const ruleId = value['id'] as string;

  const match = validateMatch(layer, ruleId, value['match'], collector);
  if (match === null) return null;

  const severity = value['severity'];
  if (severity !== 'info' && severity !== 'warn' && severity !== 'error' && severity !== 'critical') {
    collector.add(layer, ruleId, `invalid severity "${String(severity)}"`);
    return null;
  }
  const action = value['action'];
  if (action !== 'pass' && action !== 'transform' && action !== 'requireApproval' && action !== 'block') {
    collector.add(layer, ruleId, `invalid action "${String(action)}"`);
    return null;
  }
  if (!isValidVerdictCombo(severity, action)) {
    collector.add(layer, ruleId, `illegal severity+action combo "${severity}+${action}" (v2 6.2 matrix)`);
    return null;
  }

  let mode: RuleMode = 'enforce';
  if (value['mode'] !== undefined) {
    if (value['mode'] !== 'off' && value['mode'] !== 'shadow' && value['mode'] !== 'enforce') {
      collector.add(layer, ruleId, `invalid mode "${String(value['mode'])}" (off | shadow | enforce)`);
      return null;
    }
    mode = value['mode'];
  }

  let check = 'always';
  if (value['check'] !== undefined) {
    const checkError = validateName(value['check'], 'rule.check');
    if (checkError !== null) {
      collector.add(layer, ruleId, checkError);
      return null;
    }
    check = value['check'] as string;
  }

  let fixer: string | null = null;
  if (action === 'transform') {
    if (value['fixer'] === undefined) {
      collector.add(layer, ruleId, 'transform rules must declare a named fixer (v2 6.4)');
      return null;
    }
    const fixerError = validateName(value['fixer'], 'rule.fixer');
    if (fixerError !== null) {
      collector.add(layer, ruleId, fixerError);
      return null;
    }
    fixer = value['fixer'] as string;
  } else if (value['fixer'] !== undefined) {
    collector.add(layer, ruleId, `fixer is only allowed on transform rules (action is "${action}")`);
    return null;
  }

  const message = value['message'];
  if (typeof message !== 'string' || message.length === 0 || message.length > 200) {
    collector.add(layer, ruleId, 'rule.message must be a non-empty string (<= 200 chars)');
    return null;
  }

  return {
    id: ruleId,
    layer,
    matchComponent: match.component,
    presentProps: match.present,
    absentProps: match.absent,
    check,
    checkFn: () => true,
    severity,
    action,
    mode,
    fixer,
    message,
  };
}

function hashableRule(rule: CompiledRule): JsonValue {
  const match: Record<string, JsonValue> = {};
  if (rule.matchComponent !== null) match['component'] = rule.matchComponent;
  if (rule.presentProps.length > 0 || rule.absentProps.length > 0) {
    const props: Record<string, JsonValue> = {};
    if (rule.presentProps.length > 0) props['present'] = rule.presentProps;
    if (rule.absentProps.length > 0) props['absent'] = rule.absentProps;
    match['props'] = props;
  }
  return {
    id: rule.id,
    layer: rule.layer,
    match,
    check: rule.check,
    severity: rule.severity,
    action: rule.action,
    mode: rule.mode,
    fixer: rule.fixer ?? null,
    message: rule.message,
  };
}

export interface CompilePolicyOptions {
  /** 宿主侧内置谓词扩充（代码内注册，非文档侧；不可移除内置项） */
  checks?: CheckRegistry;
}

/**
 * 编译策略文档（v2 §7.1）：
 * - 分层合并单调收紧——放宽低层规则（action/severity/mode 任一降档）→ 编译错误（带规则 ID）；
 * - 同层同 ID 重复 → 编译错误；
 * - 编译产物 = 索引化谓词表（按组件分桶），policyHash = 合并后规则集 canonical JSON 的 sha256；
 * - 任何校验失败 fail-closed 抛 PolicyCompileError（收集全部 issue），不产出半成品。
 */
export function compilePolicy(doc: PolicyDocument, options: CompilePolicyOptions = {}): CompiledPolicy {
  const collector = makeCollector();
  const checks: CheckRegistry = { ...BUILTIN_CHECKS, ...options.checks };
  const rules: CompiledRule[] = [];
  const byId = new Map<string, CompiledRule>();

  for (const layer of LAYER_ORDER) {
    const layerRules = (doc as Record<string, unknown>)[layer];
    if (layerRules === undefined) continue;
    if (!Array.isArray(layerRules)) {
      collector.add(layer, null, 'layer must be an array of rules');
      continue;
    }
    const seen = new Set<string>();
    for (const raw of layerRules) {
      const compiled = validateRule(layer, raw, collector);
      if (compiled === null) continue;
      if (seen.has(compiled.id)) {
        collector.add(layer, compiled.id, `duplicate rule id "${compiled.id}" within layer`);
        continue;
      }
      seen.add(compiled.id);
      const checkFn = checks[compiled.check];
      if (checkFn === undefined) {
        collector.add(layer, compiled.id, `unknown check "${compiled.check}"`);
        continue;
      }
      const previous = byId.get(compiled.id);
      if (previous !== undefined) {
        const relaxations: string[] = [];
        if (ACTION_RANK[compiled.action] < ACTION_RANK[previous.action]) {
          relaxations.push(`action ${previous.action} -> ${compiled.action}`);
        }
        if (SEVERITY_RANK[compiled.severity] < SEVERITY_RANK[previous.severity]) {
          relaxations.push(`severity ${previous.severity} -> ${compiled.severity}`);
        }
        if (MODE_RANK[compiled.mode] < MODE_RANK[previous.mode]) {
          relaxations.push(`mode ${previous.mode} -> ${compiled.mode}`);
        }
        if (relaxations.length > 0) {
          collector.add(layer, compiled.id, `rule relaxes lower layer rule "${compiled.id}" (${relaxations.join(', ')}); merge is monotone tighten-only (v2 7.1)`);
          continue;
        }
      }
      const resolved: CompiledRule = { ...compiled, checkFn };
      byId.set(compiled.id, resolved);
      const existingIndex = rules.findIndex((rule) => rule.id === compiled.id);
      if (existingIndex >= 0) {
        rules[existingIndex] = resolved;
      } else {
        rules.push(resolved);
      }
    }
  }

  if (collector.issues.length > 0) {
    throw new PolicyCompileError(collector.issues);
  }

  const buckets = new Map<string | null, number[]>();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const key = rule.matchComponent;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [i]);
    } else {
      bucket.push(i);
    }
  }

  return {
    policyHash: canonicalHash(rules.map(hashableRule)),
    rules,
    buckets,
    checks,
  };
}
