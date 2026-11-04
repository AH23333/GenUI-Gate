import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import { specHash } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluatePolicy } from '@genui/policy';
import type { PolicyDocument, PolicyRuleData } from '@genui/policy';
import { gate, projectVerdict, type PolicyEvaluation } from '../src/index';
import type { Fixer } from '../src/index';

// ---------------------------------------------------------------------------
// M1 task 1.4 (part 2) — gate wiring: policy stage + fix stage end-to-end
// (v2 §6.1 order limits→schema→whitelist→policy→budget→fix; §6.4 runtime
// completeness re-check; §15.0 idempotency with transform wired).
// ---------------------------------------------------------------------------

function makeNode(id: string, type: string, props: JsonObject, slots: Record<string, IRNode[]>): IRNode {
  return { id, type, props, slots };
}

/** 完备修复器：缺 label 补 'auto'，已有则拒绝（null → fail-closed block） */
const ensureLabel: Fixer = (node) => {
  if (node.props['label'] !== undefined) return null;
  return {
    node: { ...node, props: { ...node.props, label: 'auto' } },
    before: null,
    after: 'auto',
  };
};

/** 不完备修复器：声称修 label，实际改无关 prop（触发 §6.4 复检降级） */
const bogusFixer: Fixer = (node) => ({
  node: { ...node, props: { ...node.props, touched: true } },
  before: null,
  after: true,
});

const FIXERS = { ensureLabel, bogusFixer };

function policy(ir: IRNode, doc: PolicyDocument): PolicyEvaluation {
  return evaluatePolicy(compilePolicy(doc), ir);
}

const unlabeledButtonRule: PolicyRuleData = {
  id: 'button-needs-label',
  match: { component: 'Button', props: { absent: ['label'] } },
  severity: 'warn',
  action: 'transform',
  fixer: 'ensureLabel',
  message: 'button has no label',
};

function tree(): IRNode {
  return makeNode('r', 'Column', {}, {
    content: [
      makeNode('b1', 'Button', {}, {}),
      makeNode('b2', 'Button', { label: 'keep' }, {}),
    ],
  });
}

describe('gate with policy + fix wiring', () => {
  it('applies a complete transform fixer and projects the fixed IR (v2 6.3)', () => {
    const result = gate(tree(), {
      policy: (ir) => policy(ir, { baseline: [unlabeledButtonRule] }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('transform');
    expect(result.ir.slots['content']![0]!.props['label']).toBe('auto');
    expect(result.ir.slots['content']![1]!.props['label']).toBe('keep');
    expect(result.ir.slots['content']![1]!.props['touched']).toBeUndefined();
    expect(result.trace).toEqual([
      {
        ruleId: 'button-needs-label',
        severity: 'warn',
        action: 'transform',
        nodePath: '<root>/slots.content[0]',
        message: 'button has no label',
      },
      {
        ruleId: 'button-needs-label',
        severity: 'warn',
        action: 'transform',
        nodePath: '<root>/slots.content[0]',
        message: 'button has no label',
        before: null,
        after: 'auto',
      },
    ]);
  });

  it('degrades an incomplete fixer to error+requireApproval via the 6.4 re-check', () => {
    const result = gate(tree(), {
      policy: (ir) => policy(ir, { baseline: [{ ...unlabeledButtonRule, fixer: 'bogusFixer' }] }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('requireApproval');
    const degraded = result.trace[1]!;
    expect(degraded.action).toBe('requireApproval');
    expect(degraded.severity).toBe('error');
    expect(degraded.message).toContain('transform degraded to requireApproval');
  });

  it('degrades an unknown fixer to error+block (fail-closed)', () => {
    const result = gate(tree(), {
      policy: (ir) => policy(ir, { baseline: [{ ...unlabeledButtonRule, fixer: 'missing' }] }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('block');
    expect(result.trace[1]!.action).toBe('block');
    expect(result.trace[1]!.message).toContain('unknown fixer "missing"');
  });

  it('keeps requireApproval and block rules fix-free', () => {
    const result = gate(tree(), {
      policy: (ir) =>
        policy(ir, {
          baseline: [
            { id: 'buttons-need-review', match: { component: 'Button' }, severity: 'error', action: 'requireApproval', message: 'review buttons' },
          ],
        }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('requireApproval');
    expect(result.trace).toHaveLength(2);
    expect(result.trace.every((entry) => entry.action === 'requireApproval')).toBe(true);
  });

  it('records shadow rules without affecting the verdict or fixing anything', () => {
    const result = gate(tree(), {
      policy: (ir) =>
        policy(ir, {
          baseline: [
            { id: 'shadow-label', mode: 'shadow', match: { component: 'Button', props: { absent: ['label'] } }, severity: 'error', action: 'block', message: 'would block' },
          ],
        }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('pass');
    expect(result.ir.slots['content']![0]!.props['label']).toBeUndefined();
    expect(result.trace).toEqual([
      {
        ruleId: 'shadow-label',
        severity: 'error',
        action: 'pass',
        shadowAction: 'block',
        nodePath: '<root>/slots.content[0]',
        message: '[shadow] would block',
      },
    ]);
  });

  it('checks budget on the pre-fix IR but fix before returning (v2 6.1 order)', () => {
    const withLongText = makeNode('r', 'Column', {}, {
      content: [
        makeNode('t', 'Text', { text: 'a'.repeat(10_001) }, {}),
        makeNode('b', 'Button', {}, {}),
      ],
    });
    const result = gate(withLongText, {
      policy: (ir) => policy(ir, { baseline: [unlabeledButtonRule] }),
      fixers: FIXERS,
    });
    expect(result.verdict).toBe('block');
    const budgetIndex = result.trace.findIndex((entry) => entry.ruleId === 'budget.text-length');
    const fixIndex = result.trace.findIndex((entry) => entry.action === 'transform' && entry.before !== undefined);
    expect(budgetIndex).toBeGreaterThanOrEqual(0);
    expect(fixIndex).toBeGreaterThan(budgetIndex);
    expect(result.ir.slots['content']![1]!.props['label']).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// v2 §15.0 — idempotency with transform wired: gate(gate(x).ir) reaches the
// IR fixed point and the second verdict equals projectVerdict(first).
// ---------------------------------------------------------------------------

describe('gate idempotency with policy + fix (v2 15.0)', () => {
  const TYPES = ['Text', 'Row', 'Column', 'Button'];

  const valueArb = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1000, max: 1000 }),
    fc.string({ maxLength: 8 }),
  );

  interface RawNode {
    type: string;
    props: Record<string, JsonValue>;
    slots: Record<string, RawNode[]>;
  }

  function rawNodeArb(depth: number): fc.Arbitrary<RawNode> {
    if (depth <= 0) {
      return fc.record({ type: fc.constantFrom(...TYPES), props: fc.dictionary(fc.string({ maxLength: 6 }), valueArb), slots: fc.constant({}) });
    }
    return fc.record({
      type: fc.constantFrom(...TYPES),
      props: fc.dictionary(fc.string({ maxLength: 6 }), valueArb),
      slots: fc.dictionary(fc.string({ maxLength: 6 }), fc.array(rawNodeArb(depth - 1), { maxLength: 2 })),
    });
  }

  function materialize(raw: RawNode, allocId: () => string): IRNode {
    const slots: Record<string, IRNode[]> = {};
    for (const slotName of Object.keys(raw.slots)) {
      slots[slotName] = raw.slots[slotName]!.map((child) => materialize(child, allocId));
    }
    return { id: allocId(), type: raw.type, props: raw.props, slots };
  }

  function irArb(): fc.Arbitrary<IRNode> {
    return rawNodeArb(3).map((raw) => {
      let counter = 0;
      return materialize(raw, () => `n${counter++}`);
    });
  }

  it('reaching the fixed point and projecting the verdict', () => {
    const doc: PolicyDocument = { baseline: [unlabeledButtonRule] };
    const property = fc.property(irArb(), (ir) => {
      const first = gate(ir, { policy: (x) => policy(x, doc), fixers: FIXERS });
      const second = gate(first.ir, { policy: (x) => policy(x, doc), fixers: FIXERS });
      expect(specHash(second.ir)).toBe(specHash(first.ir));
      expect(second.verdict).toBe(projectVerdict(first.verdict));
    });
    fc.assert(property, { numRuns: 100 });
  });
});
