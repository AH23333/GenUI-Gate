import type { A2UIMessage } from '@genui/adapter-a2ui';
import type { JsonObject } from '@genui/ir';

/** 提议目标：规则 id + 模板参数。同一 goal 恒提议同一帧（确定性，v2 §17-P0：不调 LLM） */
export interface ProposerGoal {
  readonly ruleId: string;
  readonly params?: JsonObject;
}

/**
 * 规则/模板（v2 §17-P0「规则/模板选择的最小 Agent 提议器」）：
 * 纯函数 `(params) → A2UI 帧`。硬性约束——
 *
 * - 无时钟、无随机、无外部 I/O：同 params 恒得同一帧；
 * - 参数非法 fail-loud 抛 RangeError，不静默降级（§14 纪律）。
 */
export interface ProposerRule {
  readonly id: string;
  readonly description: string;
  readonly instantiate: (params: JsonObject) => A2UIMessage;
}
