import { describe, expect, it } from 'vitest';
import { BUILTIN_CHECKS, PolicyCompileError, compilePolicy } from '../src/index';
import type { PolicyDocument, PolicyRuleData } from '../src/index';
import type { Severity, VerdictAction } from '@genui/gate';

function expectIssue(doc: PolicyDocument, fragment: string): PolicyCompileError {
  try {
    compilePolicy(doc);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyCompileError);
    const compileError = error as PolicyCompileError;
    expect(compileError.message).toContain(fragment);
    return compileError;
  }
  throw new Error(`expected compilePolicy to fail (fragment: ${fragment})`);
}

describe('compilePolicy', () => {
  it('compiles a minimal baseline document with a deterministic policyHash', () => {
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
    const compiled = compilePolicy(doc);
    expect(compiled.rules).toHaveLength(1);
    expect(compiled.rules[0]!.mode).toBe('enforce');
    expect(compiled.rules[0]!.check).toBe('always');
    expect(compiled.rules[0]!.fixer).toBeNull();
    expect(compiled.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compilePolicy(doc).policyHash).toBe(compiled.policyHash);
  });

  it('compiles an empty document', () => {
    const compiled = compilePolicy({});
    expect(compiled.rules).toHaveLength(0);
    expect(compiled.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults mode to enforce and check to always', () => {
    const compiled = compilePolicy({
      baseline: [{ id: 'r1', severity: 'info', action: 'pass', message: 'm' }],
    });
    expect(compiled.rules[0]!.mode).toBe('enforce');
    expect(compiled.rules[0]!.check).toBe('always');
    expect(compiled.checks['always']).toBe(BUILTIN_CHECKS['always']);
  });

  it('allows higher layers to tighten an existing rule (severity/action/mode up)', () => {
    const compiled = compilePolicy({
      baseline: [{ id: 'shared', severity: 'warn', action: 'pass', mode: 'shadow', message: 'base' }],
      app: [{ id: 'shared', severity: 'warn', action: 'requireApproval', mode: 'enforce', message: 'tightened' }],
    });
    expect(compiled.rules).toHaveLength(1);
    expect(compiled.rules[0]!.action).toBe('requireApproval');
    expect(compiled.rules[0]!.mode).toBe('enforce');
    expect(compiled.rules[0]!.layer).toBe('app');
  });

  it('rejects relaxing a lower-layer rule with the rule id in the error', () => {
    expectIssue(
      {
        baseline: [{ id: 'shared', severity: 'error', action: 'block', message: 'base' }],
        app: [{ id: 'shared', severity: 'error', action: 'requireApproval', message: 'relaxed' }],
      },
      'app/shared',
    );
    const runtimeError = expectIssue(
      {
        baseline: [{ id: 'shared', severity: 'error', action: 'requireApproval', message: 'base' }],
        runtime: [{ id: 'shared', severity: 'warn', action: 'requireApproval', message: 'relaxed' }],
      },
      'shared',
    );
    expect(runtimeError.issues[0]!.message).toContain('monotone tighten-only');
    expectIssue(
      {
        baseline: [{ id: 'shared', severity: 'warn', action: 'requireApproval', mode: 'enforce', message: 'base' }],
        app: [{ id: 'shared', severity: 'warn', action: 'requireApproval', mode: 'shadow', message: 'relaxed' }],
      },
      'mode enforce -> shadow',
    );
  });

  it('rejects duplicate rule ids within a layer but allows cross-layer overrides', () => {
    expectIssue(
      {
        baseline: [
          { id: 'dup', severity: 'info', action: 'pass', message: 'a' },
          { id: 'dup', severity: 'info', action: 'pass', message: 'b' },
        ],
      },
      'duplicate rule id "dup"',
    );
  });

  it('rejects unknown checks', () => {
    expectIssue(
      { baseline: [{ id: 'r', check: 'definitelyNotBuiltin', severity: 'info', action: 'pass', message: 'm' }] },
      'unknown check "definitelyNotBuiltin"',
    );
  });

  it('rejects every illegal severity+action combo (v2 6.2 matrix)', () => {
    const illegal: Array<[Severity, VerdictAction]> = [
      ['info', 'transform'],
      ['info', 'requireApproval'],
      ['info', 'block'],
      ['warn', 'block'],
      ['critical', 'pass'],
      ['critical', 'transform'],
      ['critical', 'requireApproval'],
      ['error', 'pass'],
    ];
    for (const [severity, action] of illegal) {
      expectIssue(
        { baseline: [{ id: 'r', severity, action, message: 'm' }] },
        `illegal severity+action combo "${severity}+${action}"`,
      );
    }
  });

  it('requires a named fixer on transform rules and forbids it elsewhere', () => {
    expectIssue(
      { baseline: [{ id: 'r', severity: 'warn', action: 'transform', message: 'm' }] },
      'transform rules must declare a named fixer',
    );
    expectIssue(
      { baseline: [{ id: 'r', severity: 'critical', action: 'block', fixer: 'nope', message: 'm' }] },
      'fixer is only allowed on transform rules',
    );
  });

  it('rejects unknown fields on rule, match and match.props (closed field set)', () => {
    const hostileRule: Record<string, unknown> = {
      baseline: [
        {
          id: 'r',
          severity: 'info',
          action: 'pass',
          message: 'm',
          execute: '(node) => process.exit(1)',
        },
      ],
    };
    expectIssue(hostileRule as unknown as PolicyDocument, 'rule has unknown field "execute"');
    const hostileMatch: Record<string, unknown> = {
      baseline: [
        { id: 'r', match: { component: 'Button', where: '1=1' }, severity: 'info', action: 'pass', message: 'm' },
      ],
    };
    expectIssue(hostileMatch as unknown as PolicyDocument, 'match has unknown field "where"');
    const hostileProps: Record<string, unknown> = {
      baseline: [
        { id: 'r', match: { props: { equals: { label: 'x' } } }, severity: 'info', action: 'pass', message: 'm' },
      ],
    };
    expectIssue(hostileProps as unknown as PolicyDocument, 'match.props has unknown field "equals"');
  });

  it('collects multiple issues into one fail-closed error', () => {
    const error = expectIssue(
      {
        baseline: [
          { id: 'a', severity: 'info', action: 'block', message: 'm' },
          { id: 'b', check: 'missing', severity: 'info', action: 'pass', message: 'm' },
        ],
      },
      'policy compilation failed with 2 issue(s)',
    );
    expect(error.issues).toHaveLength(2);
  });

  it('registers host-side checks without removing builtins', () => {
    const compiled = compilePolicy(
      {
        baseline: [{ id: 'r', check: 'customCheck', severity: 'info', action: 'pass', message: 'm' }],
      },
      { checks: { customCheck: () => true } },
    );
    expect(compiled.checks['customCheck']).toBeDefined();
    expect(compiled.checks['always']).toBe(BUILTIN_CHECKS['always']);
  });
});
