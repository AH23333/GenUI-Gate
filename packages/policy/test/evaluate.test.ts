import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { beforeEach, describe, expect, it } from 'vitest';
import { compilePolicy, evaluatePolicy } from '../src/index';
import type { PolicyDocument } from '../src/index';

function makeNode(id: string, type: string, props: JsonObject, slots: Record<string, IRNode[]>): IRNode {
  return { id, type, props, slots };
}

let root: IRNode;

beforeEach(() => {
  root = makeNode('r', 'Column', { title: 'menu' }, {
    content: [
      makeNode('t1', 'Text', { text: 'hello' }, {}),
      makeNode('b1', 'Button', {}, {
        icon: [makeNode('i1', 'Icon', { name: 'star' }, {})],
      }),
      makeNode('b2', 'Button', { label: 'ok' }, {}),
    ],
  });
});

describe('evaluatePolicy', () => {
  it('matches rules by component type via buckets', () => {
    const doc: PolicyDocument = {
      baseline: [{ id: 'button-no-label', match: { component: 'Button', props: { absent: ['label'] } }, severity: 'warn', action: 'requireApproval', message: 'unlabeled button' }],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([
      {
        ruleId: 'button-no-label',
        severity: 'warn',
        action: 'requireApproval',
        nodePath: '<root>/slots.content[1]',
        message: 'unlabeled button',
      },
    ]);
    expect(result.fixRequests).toEqual([]);
  });

  it('matches global rules (no component) against every node', () => {
    const doc: PolicyDocument = {
      baseline: [{ id: 'any-node', severity: 'info', action: 'pass', message: 'saw a node' }],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => entry.nodePath)).toEqual([
      '<root>',
      '<root>/slots.content[0]',
      '<root>/slots.content[1]',
      '<root>/slots.content[1]/slots.icon[0]',
      '<root>/slots.content[2]',
    ]);
  });

  it('honors present/absent prop conditions', () => {
    const doc: PolicyDocument = {
      baseline: [
        { id: 'has-label', match: { component: 'Button', props: { present: ['label'] } }, severity: 'info', action: 'pass', message: 'labeled' },
        { id: 'no-text', match: { component: 'Text', props: { absent: ['text'] } }, severity: 'warn', action: 'requireApproval', message: 'text without content' },
      ],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.ruleId).toBe('has-label');
    expect(result.entries[0]!.nodePath).toBe('<root>/slots.content[2]');
  });

  it('skips off rules entirely', () => {
    const doc: PolicyDocument = {
      baseline: [{ id: 'off-rule', mode: 'off', severity: 'critical', action: 'block', message: 'never fires' }],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([]);
    expect(result.fixRequests).toEqual([]);
  });

  it('records shadow rules as pass entries with shadowAction and no fix requests', () => {
    const doc: PolicyDocument = {
      baseline: [
        { id: 'shadow-transform', mode: 'shadow', match: { component: 'Button', props: { absent: ['label'] } }, severity: 'warn', action: 'transform', fixer: 'labelFromContent', message: 'would fix' },
      ],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([
      {
        ruleId: 'shadow-transform',
        severity: 'warn',
        action: 'pass',
        shadowAction: 'transform',
        nodePath: '<root>/slots.content[1]',
        message: '[shadow] would fix',
      },
    ]);
    expect(result.fixRequests).toEqual([]);
  });

  it('emits entry plus fix request for enforce transform rules', () => {
    const doc: PolicyDocument = {
      baseline: [
        { id: 'fix-it', match: { component: 'Button', props: { absent: ['label'] } }, severity: 'warn', action: 'transform', fixer: 'labelFromContent', message: 'auto-fix label' },
      ],
    };
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.action).toBe('transform');
    expect(result.fixRequests).toEqual([
      {
        ruleId: 'fix-it',
        severity: 'warn',
        nodePath: '<root>/slots.content[1]',
        fixer: 'labelFromContent',
        message: 'auto-fix label',
      },
    ]);
  });

  it('passes node and path to host-registered checks', () => {
    const seen: Array<[string, string]> = [];
    const doc: PolicyDocument = {
      baseline: [{ id: 'probe', check: 'probeCheck', match: { component: 'Text' }, severity: 'info', action: 'pass', message: 'probe' }],
    };
    const compiled = compilePolicy(doc, {
      checks: {
        probeCheck: (node, path): boolean => {
          seen.push([node.id, path]);
          return false;
        },
      },
    });
    const result = evaluatePolicy(compiled, root);
    expect(result.entries).toEqual([]);
    expect(seen).toEqual([['t1', '<root>/slots.content[0]']]);
  });

  it('is deterministic across repeated evaluations', () => {
    const doc: PolicyDocument = {
      baseline: [
        { id: 'a', match: { component: 'Button' }, severity: 'warn', action: 'requireApproval', message: 'a' },
        { id: 'b', severity: 'info', action: 'pass', message: 'b' },
      ],
    };
    const compiled = compilePolicy(doc);
    const first = evaluatePolicy(compiled, root);
    const second = evaluatePolicy(compiled, root);
    expect(second.entries).toEqual(first.entries);
    expect(second.fixRequests).toEqual(first.fixRequests);
  });
});
