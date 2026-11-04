/**
 * 优先级仲裁（v2 §9.2）：固定求值序，确定性，结果进 trace。
 *
 * 求值序（先到先决，短路）：
 *   用户锁定（zone 级硬停） > 用户偏好 > 平台策略（zones/预算） > Agent 提议 > 保守默认
 *
 * 确认策略（confirmation）本身由 policy 决定（user-confirm / auto / never）；
 * 本函数只做优先级裁决：第一个有权决定的层给出 confirmation，后续层不再求值。
 * 「为什么这样展示」直接由 trace 渲染——解释的可验证性优先于流畅性，
 * 禁止 LLM 生成解释（v2 §9.2 沿用 v1）。
 */

/** 确认策略（v2 §9.2）：user-confirm（运营侧默认）/ auto（低风险白名单变更）/ never */
export type ConfirmationPolicy = 'user-confirm' | 'auto' | 'never';

/** 宿主侧仲裁请求（不含 userLock——由 Session 注入其权威锁状态） */
export interface ArbitrationRequest {
  readonly userPreference?: ConfirmationPolicy;
  readonly platformPolicy?: ConfirmationPolicy;
  readonly agentRequest?: ConfirmationPolicy;
}

/** arbitrate() 的完整输入：请求 + Session 权威的 zone 锁状态 */
export interface ArbitrationInputs extends ArbitrationRequest {
  readonly userLock: boolean;
}

/** 求值层级，即固定优先级序 */
export type ArbitrationLevel = 'user-lock' | 'user-preference' | 'platform-policy' | 'agent-proposal' | 'default';

export interface ArbitrationTraceEntry {
  readonly level: ArbitrationLevel;
  readonly outcome: 'deny' | 'decide' | 'skip';
  readonly detail: string;
}

export interface ArbitrationResult {
  /** false = 拒绝（仅 user-lock 会拒绝）；true = 允许进入提案流程 */
  readonly allowed: boolean;
  /** 生效的确认策略；仅 allowed === true 时有意义（拒绝时保守置 user-confirm） */
  readonly confirmation: ConfirmationPolicy;
  /** 做出决定的层级 */
  readonly decidedBy: ArbitrationLevel;
  /** 固定求值序的完整轨迹（含跳过层），随提案进 trace */
  readonly trace: readonly ArbitrationTraceEntry[];
}

function decide(
  trace: ArbitrationTraceEntry[],
  level: ArbitrationLevel,
  source: string,
  confirmation: ConfirmationPolicy,
): ArbitrationResult {
  trace.push({ level, outcome: 'decide', detail: `${source} decides confirmation "${confirmation}"` });
  return { allowed: true, confirmation, decidedBy: level, trace };
}

/**
 * 纯函数、确定性：同一输入恒得同一 trace 与结果。
 * 拒绝路径只走 level 1（用户锁定 = zone 级硬停）；
 * 硬性拒绝（zone 越权/预算超限）由 gate 的 whitelist/budget 阶段以 block verdict 表达，
 * 在进入本函数之前就已出局。
 */
export function arbitrate(inputs: ArbitrationInputs): ArbitrationResult {
  const trace: ArbitrationTraceEntry[] = [];

  // Level 1: 用户锁定（zone 级硬停）——最高优先级，唯一拒绝层
  if (inputs.userLock) {
    trace.push({ level: 'user-lock', outcome: 'deny', detail: 'zone-level user lock is active' });
    return { allowed: false, confirmation: 'user-confirm', decidedBy: 'user-lock', trace };
  }
  trace.push({ level: 'user-lock', outcome: 'skip', detail: 'zone not locked' });

  // Level 2: 用户偏好
  if (inputs.userPreference !== undefined) {
    return decide(trace, 'user-preference', 'user preference', inputs.userPreference);
  }
  trace.push({ level: 'user-preference', outcome: 'skip', detail: 'no user preference set' });

  // Level 3: 平台策略（zones/预算）
  if (inputs.platformPolicy !== undefined) {
    return decide(trace, 'platform-policy', 'platform policy', inputs.platformPolicy);
  }
  trace.push({ level: 'platform-policy', outcome: 'skip', detail: 'no platform policy set' });

  // Level 4: Agent 提议
  if (inputs.agentRequest !== undefined) {
    return decide(trace, 'agent-proposal', 'agent request', inputs.agentRequest);
  }
  trace.push({ level: 'agent-proposal', outcome: 'skip', detail: 'no agent request set' });

  // 保守默认（运营侧默认，v2 §9.2）
  return decide(trace, 'default', 'conservative fallback', 'user-confirm');
}
