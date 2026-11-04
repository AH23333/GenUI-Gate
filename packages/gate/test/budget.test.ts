import type { IRNode, JsonObject } from '@genui/ir';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS, checkBudget } from '../src/budget';
import { aggregate, gate, isValidVerdictCombo, projectVerdict } from '../src/gate';
import type { Severity, TraceEntry, VerdictAction } from '../src/types';

function node(id: string, props: JsonObject, slots: Record<string, IRNode[]> = {}): IRNode {
  return { id, type: 'Text', props, slots };
}

describe('checkBudget', () => {
  it('passes small text and list props', () => {
    const ir = node('n1', { content: 'hello', tags: ['a', 'b'] });
    expect(checkBudget(ir, DEFAULT_BUDGETS)).toEqual([]);
  });

  it('flags text over the code-point budget at the exact path', () => {
    const ir = node('n1', { content: 'a'.repeat(DEFAULT_BUDGETS.maxTextLength + 1) });
    const violations = checkBudget(ir, DEFAULT_BUDGETS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: 'budget.text-length',
      severity: 'error',
      action: 'block',
      nodePath: '<root>.props.content',
    });
  });

  it('counts surrogate pairs as single code points for the text budget', () => {
    const ir = node('n1', { content: '😀'.repeat(DEFAULT_BUDGETS.maxTextLength + 1) });
    expect(checkBudget(ir, DEFAULT_BUDGETS)).toHaveLength(1);
    const exact = node('n1', { content: '😀'.repeat(DEFAULT_BUDGETS.maxTextLength) });
    expect(checkBudget(exact, DEFAULT_BUDGETS)).toEqual([]);
  });

  it('flags lists over the item budget', () => {
    const ir = node('n1', { tags: Array.from({ length: DEFAULT_BUDGETS.maxListLength + 1 }, (_, i) => `t${i}`) });
    const violations = checkBudget(ir, DEFAULT_BUDGETS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ruleId: 'budget.list-length', nodePath: '<root>.props.tags' });
  });

  it('scans text and lists nested inside object props', () => {
    const ir = node('n1', {
      config: { greeting: 'b'.repeat(DEFAULT_BUDGETS.maxTextLength + 1), items: new Array(DEFAULT_BUDGETS.maxListLength + 2).fill('x') },
    });
    const violations = checkBudget(ir, DEFAULT_BUDGETS);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({ ruleId: 'budget.text-length', nodePath: '<root>.props.config.greeting' });
    expect(violations[1]).toMatchObject({ ruleId: 'budget.list-length', nodePath: '<root>.props.config.items' });
  });

  it('walks slots and flags deep nodes', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Column',
      props: {},
      slots: { default: [node('deep', { content: 'c'.repeat(DEFAULT_BUDGETS.maxTextLength * 2) })] },
    };
    expect(checkBudget(ir, DEFAULT_BUDGETS)[0]).toMatchObject({
      nodePath: '<root>/slots.default[0].props.content',
    });
  });

  it('honors custom budgets', () => {
    const ir = node('n1', { content: 'hello world' });
    expect(checkBudget(ir, { maxTextLength: 5, maxListLength: 100 })).toHaveLength(1);
    expect(checkBudget(ir, { maxTextLength: 11, maxListLength: 100 })).toEqual([]);
  });
});

describe('aggregate (verdict projection, all four actions)', () => {
  function entry(action: VerdictAction, severity: Severity): TraceEntry {
    return { ruleId: `test.${action}`, severity, action, nodePath: '<root>', message: 'synthetic' };
  }

  it('returns pass for empty trace', () => {
    expect(aggregate([])).toBe('pass');
  });

  it('ranks requireApproval above transform', () => {
    expect(aggregate([entry('transform', 'warn'), entry('requireApproval', 'warn')])).toBe('requireApproval');
    expect(aggregate([entry('requireApproval', 'error'), entry('transform', 'error')])).toBe('requireApproval');
  });

  it('ranks block above requireApproval', () => {
    expect(aggregate([entry('requireApproval', 'warn'), entry('block', 'critical')])).toBe('block');
  });

  it('keeps the strictest action regardless of trace order', () => {
    const orders: VerdictAction[][] = [
      ['pass', 'transform', 'requireApproval', 'block'],
      ['block', 'requireApproval', 'transform', 'pass'],
      ['transform', 'block', 'pass', 'requireApproval'],
    ];
    for (const order of orders) {
      const trace = order.map((action) => entry(action, action === 'block' ? 'critical' : 'warn'));
      expect(aggregate(trace)).toBe('block');
    }
  });

  it('transform beats pass even with many pass entries', () => {
    const trace = Array.from({ length: 50 }, () => entry('pass', 'info'));
    trace.push(entry('transform', 'warn'));
    expect(aggregate(trace)).toBe('transform');
  });
});

describe('isValidVerdictCombo (severity x action legality matrix, v2 §6.2)', () => {
  it('accepts every legal combination', () => {
    const legal: [Severity, VerdictAction][] = [
      ['info', 'pass'],
      ['warn', 'pass'],
      ['warn', 'transform'],
      ['warn', 'requireApproval'],
      ['error', 'transform'],
      ['error', 'requireApproval'],
      ['error', 'block'],
      ['critical', 'block'],
    ];
    for (const [severity, action] of legal) {
      expect(isValidVerdictCombo(severity, action)).toBe(true);
    }
  });

  it('rejects every illegal combination', () => {
    const illegal: [Severity, VerdictAction][] = [
      ['info', 'transform'],
      ['info', 'requireApproval'],
      ['info', 'block'],
      ['warn', 'block'],
      ['error', 'pass'],
      ['critical', 'pass'],
      ['critical', 'transform'],
      ['critical', 'requireApproval'],
    ];
    for (const [severity, action] of illegal) {
      expect(isValidVerdictCombo(severity, action)).toBe(false);
    }
  });
});

describe('projectVerdict (idempotency projection, v2 §15.0)', () => {
  it('maps transform to pass and keeps the rest fixed', () => {
    expect(projectVerdict('pass')).toBe('pass');
    expect(projectVerdict('transform')).toBe('pass');
    expect(projectVerdict('requireApproval')).toBe('requireApproval');
    expect(projectVerdict('block')).toBe('block');
  });
});

describe('gate pipeline with budget stage', () => {
  it('runs budget after whitelist in fixed stage order', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Spinner',
      props: { content: 'x'.repeat(DEFAULT_BUDGETS.maxTextLength + 1) },
      slots: {},
    };
    const result = gate(ir, {
      catalog: { Spinner: { propsSchema: { type: 'object' } } },
    });
    expect(result.verdict).toBe('block');
    expect(result.trace.map((entry) => entry.ruleId)).toEqual([
      'budget.text-length',
    ]);
  });

  it('budget violations block through the default pipeline (no catalog)', () => {
    const ir = node('n1', { tags: new Array(DEFAULT_BUDGETS.maxListLength + 1).fill('x') });
    const result = gate(ir);
    expect(result.verdict).toBe('block');
    expect(result.trace[0]!.ruleId).toBe('budget.list-length');
  });

  it('budgets are configurable through gate options', () => {
    const ir = node('n1', { content: 'hello' });
    expect(gate(ir, { budget: { maxTextLength: 3 } }).verdict).toBe('block');
    expect(gate(ir, { budget: { maxTextLength: 5 } }).verdict).toBe('pass');
  });
});
