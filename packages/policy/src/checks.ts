import type { CheckRegistry } from './types';

/**
 * 内置检查谓词注册表（v2 §7.2：check/fixer 是内置具名谓词，策略文档不可携带代码）。
 * `always` = 纯 match 规则（命中 match 即触发）。
 * baseline a11y 组合级检查（1.5）在此注册表扩充，不开放文档侧扩展点。
 */
export const BUILTIN_CHECKS: CheckRegistry = {
  always: () => true,
};
