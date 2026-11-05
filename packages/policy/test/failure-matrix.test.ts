import { describe, expect, it } from 'vitest';
import { PolicyCompileError, compilePolicy } from '../src/index';
import type { PolicyDocument, PolicyIssue } from '../src/index';

/**
 * 失败矩阵黄金测试（v2 §14，policy 包）——每行一个黄金断言组，快照级进 CI。
 *
 * §14 行 → policy 包落地映射（M1）：
 * - 「policy 编译失败」行 → compilePolicy fail-closed：收集全部 issue 后抛
 *   PolicyCompileError，不产出半成品编译产物（compile.ts:333）。宿主在启动/
 *   热更新边界捕获，拒绝以损坏策略驱动 gate——比 gate 行（evaluate 运行期抛错）
 *   更早一层防线。本文件钉死：多 issue 精确数组（layer/ruleId/message 逐字段）、
 *   放宽带 issue 带规则 ID（宿主可定位到具体规则）、编译确定性（含错误路径 ×2）。
 */

/** 同一损坏文档编译两次 → 抛出的 issues 逐字段全等（错误路径确定性黄金） */
function compileTwice(doc: PolicyDocument): { first: PolicyIssue[]; second: PolicyIssue[] } {
  const attempt = (): PolicyIssue[] => {
    try {
      compilePolicy(doc);
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCompileError);
      return (error as PolicyCompileError).issues.slice();
    }
    throw new Error('expected compilePolicy to fail');
  };
  return { first: attempt(), second: attempt() };
}

describe('policy 行：编译失败 → fail-closed 抛 PolicyCompileError（§14）', () => {
  it('黄金快照：多 issue 损坏文档 → issues 精确数组（未知字段/非法矩阵组合/放宽带，逐字段全等）', () => {
    const doc = {
      baseline: [
        { id: 'shared', severity: 'error', action: 'block', message: 'base' },
        { id: 'bad', severity: 'info', action: 'pass', message: 'm', execute: '(node) => process.exit(1)' },
        { id: 'combo', severity: 'critical', action: 'pass', message: 'm' },
      ],
      app: [{ id: 'shared', severity: 'error', action: 'requireApproval', message: 'relaxed' }],
    } as unknown as PolicyDocument;
    const { first, second } = compileTwice(doc);
    expect(first).toEqual([
      {
        layer: 'baseline',
        // 未知字段 issue 在 rule.id 校验前收集（compile.ts:157），ruleId 尚不可知 → null
        ruleId: null,
        message: 'rule has unknown field "execute" (closed field set, v2 7.2: policy documents are data, not code)',
      },
      {
        layer: 'baseline',
        ruleId: 'combo',
        message: 'illegal severity+action combo "critical+pass" (v2 6.2 matrix)',
      },
      {
        layer: 'app',
        ruleId: 'shared',
        message:
          'rule relaxes lower layer rule "shared" (action block -> requireApproval); merge is monotone tighten-only (v2 7.1)',
      },
    ]);
    expect(second).toEqual(first); // 编译确定性：错误路径 ×2 逐字段全等
  });

  it('放宽带 issue 携带规则 ID：宿主可从 issue.layer/ruleId 直接定位到具体规则', () => {
    const doc: PolicyDocument = {
      baseline: [{ id: 'shared', severity: 'error', action: 'block', message: 'base' }],
      app: [{ id: 'shared', severity: 'error', action: 'requireApproval', message: 'relaxed' }],
    };
    const { first } = compileTwice(doc);
    expect(first).toHaveLength(1);
    expect(first[0]!.layer).toBe('app');
    expect(first[0]!.ruleId).toBe('shared');
    expect(first[0]!.message).toContain('action block -> requireApproval');
  });

  it('fail-closed：抛错即无半成品——同文档内合法规则不随损坏规则部分产出', () => {
    const doc = {
      baseline: [
        { id: 'fine', severity: 'warn', action: 'requireApproval', message: 'ok' },
        { id: 'broken', check: 'definitelyNotBuiltin', severity: 'info', action: 'pass', message: 'm' },
      ],
    } as unknown as PolicyDocument;
    const { first, second } = compileTwice(doc);
    expect(first).toEqual([
      { layer: 'baseline', ruleId: 'broken', message: 'unknown check "definitelyNotBuiltin"' },
    ]);
    expect(second).toEqual(first);
    // 修复损坏规则后同文档可编译：合法规则 'fine' 完整产出（fail-closed 不 fail-dead）
    const compiled = compilePolicy({
      baseline: [{ id: 'fine', severity: 'warn', action: 'requireApproval', message: 'ok' }],
    });
    expect(compiled.rules.map((rule) => rule.id)).toEqual(['fine']);
  });

  it('成功路径确定性：合法文档编译 ×2 → policyHash 与规则表全等', () => {
    const doc: PolicyDocument = {
      baseline: [
        {
          id: 'button-needs-label',
          match: { component: 'Button', props: { absent: ['label'] } },
          severity: 'warn',
          action: 'requireApproval',
          message: 'button has no label',
        },
      ],
    };
    const a = compilePolicy(doc);
    const b = compilePolicy(doc);
    expect(b.policyHash).toBe(a.policyHash);
    expect(b.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.rules.map(({ id, layer, action, mode }) => ({ id, layer, action, mode }))).toEqual(
      a.rules.map(({ id, layer, action, mode }) => ({ id, layer, action, mode })),
    );
  });
});
