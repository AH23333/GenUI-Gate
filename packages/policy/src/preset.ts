import type { PolicyDocument } from './types';

/**
 * baseline a11y 预设（M1 任务 1.5，v3 §5：组合检查 3 条起步）。
 * 三条规则默认 **shadow**（v2 §7.3）：只记录不聚合、不阻断——官方 53 语料
 * accessibility 元数据覆盖率为 0（M0 实测），enforce 会拦截全部现存生态；
 * shadow 先测量，宿主按 zone 自行升 enforce（分层单调收紧，v2 §7.1）。
 * 语义定义 = 对 WCAG 实践的静态子集 [假设，P0 校准点]，见 KAN-023。
 */
export const BASELINE_A11Y: PolicyDocument = {
  baseline: [
    {
      id: 'a11y-heading-order',
      check: 'heading-order',
      severity: 'warn',
      action: 'requireApproval',
      mode: 'shadow',
      message: 'markdown heading skips a level (e.g. h1 followed by h3)',
    },
    {
      id: 'a11y-landmark',
      check: 'has-landmark',
      severity: 'warn',
      action: 'requireApproval',
      mode: 'shadow',
      message: 'tree has no landmark (accessibility.role in ARIA landmark roles)',
    },
    {
      id: 'a11y-focus-order',
      check: 'interactive-focusable',
      severity: 'warn',
      action: 'requireApproval',
      mode: 'shadow',
      message: 'interactive element (props.action) declares accessibility.focusable=false',
    },
  ],
};
