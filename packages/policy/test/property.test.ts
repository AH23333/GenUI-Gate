import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluatePolicy, PolicyCompileError } from '../src/index';
import type { PolicyDocument, PolicyRuleData } from '../src/index';

// ---------------------------------------------------------------------------
// M1 task 1.4 — policy fuzz (v2 §7.2/§15.5): code-shaped policy documents are
// 100% rejected at compile time; inert code-like strings inside known fields
// are inert data and always accepted; compile/evaluate are deterministic.
// ---------------------------------------------------------------------------

type Combo = readonly [string, string];

const LEGAL_COMBOS: readonly Combo[] = [
  ['info', 'pass'],
  ['warn', 'pass'],
  ['warn', 'transform'],
  ['warn', 'requireApproval'],
  ['error', 'transform'],
  ['error', 'requireApproval'],
  ['error', 'block'],
  ['critical', 'block'],
];

const CODE_KEYS: readonly string[] = [
  'code', 'expression', 'script', 'eval', 'function', 'lambda', 'regex',
  'pattern', 'exec', 'handler', 'callback', 'fn', 'src', 'body', 'run',
];

const CODE_SNIPPETS: readonly string[] = [
  '() => process.exit(1)',
  'function f() { throw new Error("x") }',
  'eval("1 + 1")',
  '/(a+)+$/.test(input)',
  '__proto__.polluted = true',
  'while (true) {}',
  'new Function("return 1")',
];

const comboArb = fc.constantFrom(...LEGAL_COMBOS);
const idArb = fc.constantFrom('rule-a', 'rule-b', 'rule-c', 'needs-label');
const modeArb = fc.option(fc.constantFrom(...(['off', 'shadow', 'enforce'] as const)), { nil: undefined });
const componentArb = fc.option(fc.constantFrom('Button', 'Text', 'Table'), { nil: undefined });

const validRuleArb: fc.Arbitrary<PolicyRuleData> = fc
  .record({
    id: idArb,
    combo: comboArb,
    mode: modeArb,
    component: componentArb,
    message: fc.string({ minLength: 1, maxLength: 30 }),
  })
  .map((r) => {
    const rule: PolicyRuleData = {
      id: r.id,
      severity: r.combo[0] as PolicyRuleData['severity'],
      action: r.combo[1] as PolicyRuleData['action'],
      message: r.message,
    };
    if (r.mode !== undefined) rule.mode = r.mode;
    if (rule.action === 'transform') rule.fixer = 'autoFixer';
    if (r.component !== undefined) rule.match = { component: r.component };
    return rule;
  });

const validDocArb: fc.Arbitrary<PolicyDocument> = fc.record({
  baseline: fc.uniqueArray(validRuleArb, { maxLength: 4, selector: (rule) => rule.id }),
});

// --- random IR ---------------------------------------------------------------

const TYPES = ['Text', 'Row', 'Column', 'Button', 'Table'];

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

// --- properties ---------------------------------------------------------------

describe('policy fuzz (v2 7.2/15.5)', () => {
  it('rejects 100% of policy documents carrying code-shaped fields', () => {
    const property = fc.property(
      fc.record({ key: fc.constantFrom(...CODE_KEYS), snippet: fc.constantFrom(...CODE_SNIPPETS), rule: validRuleArb }),
      ({ key, snippet, rule }) => {
        const hostile: Record<string, unknown> = { ...rule };
        hostile[key] = snippet;
        const doc: Record<string, unknown> = { baseline: [hostile] };
        expect(() => compilePolicy(doc as unknown as PolicyDocument)).toThrow(PolicyCompileError);
      },
    );
    fc.assert(property, { numRuns: 200 });
  });

  it('rejects code-shaped fields on match and nested positions too', () => {
    const property = fc.property(
      fc.record({ key: fc.constantFrom(...CODE_KEYS), snippet: fc.constantFrom(...CODE_SNIPPETS) }),
      ({ key, snippet }) => {
        const hostileMatch: Record<string, unknown> = { component: 'Button' };
        hostileMatch[key] = snippet;
        const doc: Record<string, unknown> = {
          baseline: [{ id: 'r', match: hostileMatch, severity: 'info', action: 'pass', message: 'm' }],
        };
        expect(() => compilePolicy(doc as unknown as PolicyDocument)).toThrow(PolicyCompileError);
      },
    );
    fc.assert(property, { numRuns: 200 });
  });

  it('accepts code-like strings inside inert fields (data, not code)', () => {
    const property = fc.property(
      fc.record({ snippet: fc.constantFrom(...CODE_SNIPPETS), rule: validRuleArb }),
      ({ snippet, rule }) => {
        const doc: PolicyDocument = { baseline: [{ ...rule, message: `${rule.message} ${snippet}` }] };
        expect(() => compilePolicy(doc)).not.toThrow();
      },
    );
    fc.assert(property, { numRuns: 200 });
  });

  it('compilation is deterministic: identical documents yield identical policyHash', () => {
    const property = fc.property(validDocArb, (doc) => {
      const first = compilePolicy(doc);
      const second = compilePolicy(doc);
      expect(second.policyHash).toBe(first.policyHash);
      expect(second.rules).toEqual(first.rules);
    });
    fc.assert(property, { numRuns: 100 });
  });

  it('evaluation is deterministic on random trees', () => {
    const property = fc.property(validDocArb, irArb(), (doc, ir) => {
      const compiled = compilePolicy(doc);
      const first = evaluatePolicy(compiled, ir);
      const second = evaluatePolicy(compiled, ir);
      expect(second.entries).toEqual(first.entries);
      expect(second.fixRequests).toEqual(first.fixRequests);
    });
    fc.assert(property, { numRuns: 100 });
  });

  it('layer relaxation is always rejected with the rule id', () => {
    const relaxPairs: readonly (readonly [Combo, Combo])[] = [
      [['error', 'block'], ['error', 'requireApproval']],
      [['warn', 'transform'], ['warn', 'pass']],
      [['warn', 'requireApproval'], ['warn', 'pass']],
      [['critical', 'block'], ['error', 'block']],
      [['error', 'transform'], ['warn', 'transform']],
    ];
    const property = fc.property(
      fc.constantFrom(...relaxPairs),
      fc.constantFrom(...(['org', 'app', 'runtime'] as const)),
      ([base, relaxed], layer) => {
        const doc: PolicyDocument = {
          baseline: [{ id: 'shared', severity: base[0] as PolicyRuleData['severity'], action: base[1] as PolicyRuleData['action'], fixer: base[1] === 'transform' ? 'autoFixer' : undefined, message: 'base' }],
        };
        doc[layer] = [{ id: 'shared', severity: relaxed[0] as PolicyRuleData['severity'], action: relaxed[1] as PolicyRuleData['action'], fixer: relaxed[1] === 'transform' ? 'autoFixer' : undefined, message: 'relaxed' }];
        expect(() => compilePolicy(doc)).toThrow(PolicyCompileError);
      },
    );
    fc.assert(property, { numRuns: 100 });
  });

  it('monotone tightening always compiles', () => {
    const tightenPairs: readonly (readonly [Combo, Combo])[] = [
      [['warn', 'pass'], ['warn', 'requireApproval']],
      [['warn', 'pass'], ['error', 'block']],
      [['error', 'requireApproval'], ['error', 'block']],
      [['info', 'pass'], ['critical', 'block']],
    ];
    const property = fc.property(fc.constantFrom(...tightenPairs), ([base, tight]) => {
      const doc: PolicyDocument = {
        baseline: [{ id: 'shared', severity: base[0] as PolicyRuleData['severity'], action: base[1] as PolicyRuleData['action'], message: 'base' }],
        app: [{ id: 'shared', severity: tight[0] as PolicyRuleData['severity'], action: tight[1] as PolicyRuleData['action'], message: 'tightened' }],
      };
      expect(() => compilePolicy(doc)).not.toThrow();
    });
    fc.assert(property, { numRuns: 100 });
  });
});
