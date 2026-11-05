import type { A2UIMessage } from '@genui/adapter-a2ui';
import type { JsonObject } from '@genui/ir';
import type { ProposerGoal, ProposerRule } from './types';

function isJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规则提议器（v2 §17-P0）：注册表 + 确定性选择/实例化。
 *
 * - 注册期校验（重复 id / 坏形状 fail-loud）；
 * - `propose(goal)`：规则实例化为一帧 A2UI 消息；未知规则 / 非法 params 抛错——
 *   提议器自身不吞错、不静默降级（fail-loud 纪律，§14）。
 */
export class RuleProposer {
  private readonly rules = new Map<string, ProposerRule>();

  constructor(rules: readonly ProposerRule[]) {
    if (!Array.isArray(rules)) {
      throw new TypeError('rules must be an array of ProposerRule');
    }
    for (const rule of rules) {
      if (!isJsonObject(rule)) {
        throw new TypeError('each rule must be an object');
      }
      if (typeof rule.id !== 'string' || rule.id === '') {
        throw new RangeError('rule.id must be a non-empty string');
      }
      if (typeof rule.description !== 'string') {
        throw new TypeError(`rule "${rule.id}": description must be a string`);
      }
      if (typeof rule.instantiate !== 'function') {
        throw new TypeError(`rule "${rule.id}": instantiate must be a function`);
      }
      if (this.rules.has(rule.id)) {
        throw new RangeError(`duplicate rule id "${rule.id}"`);
      }
      this.rules.set(rule.id, rule);
    }
  }

  /** 规则 id 列表（注册序，确定性） */
  getRuleIds(): string[] {
    return [...this.rules.keys()];
  }

  has(ruleId: string): boolean {
    return typeof ruleId === 'string' && this.rules.has(ruleId);
  }

  /** 提议一帧：未知规则 / 非法参数抛 RangeError（fail-loud） */
  propose(goal: ProposerGoal): A2UIMessage {
    if (!isJsonObject(goal)) {
      throw new TypeError('goal must be an object');
    }
    if (typeof goal.ruleId !== 'string' || goal.ruleId === '') {
      throw new RangeError('goal.ruleId must be a non-empty string');
    }
    if (goal.params !== undefined && !isJsonObject(goal.params)) {
      throw new RangeError('goal.params must be a JSON object when provided');
    }
    const rule = this.rules.get(goal.ruleId);
    if (rule === undefined) {
      throw new RangeError(`unknown rule "${goal.ruleId}"`);
    }
    return rule.instantiate(goal.params ?? {});
  }
}
