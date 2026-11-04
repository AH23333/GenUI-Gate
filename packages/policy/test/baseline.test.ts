import { gate, projectVerdict } from '@genui/gate';
import type { TraceEntry } from '@genui/gate';
import { specHash } from '@genui/ir';
import type { IRNode, JsonObject } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BASELINE_A11Y, compilePolicy, evaluatePolicy, parseHeadingLevel } from '../src/index';
import type { PolicyDocument } from '../src/index';

function makeNode(id: string, type: string, props: JsonObject, slots: Record<string, IRNode[]>): IRNode {
  return { id, type, props, slots };
}

function text(id: string, value: string): IRNode {
  return makeNode(id, 'Text', { text: value }, {});
}

function column(id: string, children: IRNode[]): IRNode {
  return makeNode(id, 'Column', {}, { content: children });
}

describe('baseline a11y preset (M1 task 1.5)', () => {
  it('compiles and has a deterministic policyHash', () => {
    const first = compilePolicy(BASELINE_A11Y);
    const second = compilePolicy(BASELINE_A11Y);
    expect(second.policyHash).toBe(first.policyHash);
    expect(first.rules.map((rule) => rule.id)).toEqual(['a11y-heading-order', 'a11y-landmark', 'a11y-focus-order']);
    expect(first.rules.every((rule) => rule.mode === 'shadow')).toBe(true);
  });
});

describe('parseHeadingLevel', () => {
  it('parses ATX headings with mandatory whitespace', () => {
    expect(parseHeadingLevel('# Title')).toBe(1);
    expect(parseHeadingLevel('## Login')).toBe(2);
    expect(parseHeadingLevel('###### Deep')).toBe(6);
    expect(parseHeadingLevel('#NoSpace')).toBeNull();
    expect(parseHeadingLevel('####### Seven')).toBeNull();
    expect(parseHeadingLevel('plain text')).toBeNull();
    expect(parseHeadingLevel('  # indented')).toBeNull();
  });
});

describe('a11y-heading-order', () => {
  const doc: PolicyDocument = {
    baseline: [{ id: 'h', check: 'heading-order', severity: 'warn', action: 'requireApproval', message: 'skip' }],
  };

  it('fires on a skipped heading level in document order', () => {
    const root = column('r', [text('h1', '# One'), text('h3', '### Three')]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!).toMatchObject({ ruleId: 'h', nodePath: '<root>/slots.content[1]' });
  });

  it('accepts monotone sequences, sibling repeats and first-heading-any-level', () => {
    const root = column('r', [
      text('a', '## Start at two'),
      text('b', '## Sibling two'),
      text('c', '### Down to three'),
      text('d', '# Back to one'),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([]);
  });

  it('counts headings across nested slots in document order (not per branch)', () => {
    const root = column('r', [
      column('c1', [text('a', '# One')]),
      column('c2', [text('b', '### Three')]),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.nodePath).toBe('<root>/slots.content[1]/slots.content[0]');
  });

  it('counts any component carrying a heading-shaped text prop (protocol-agnostic)', () => {
    const root = column('r', [
      makeNode('card', 'Card', { text: '# One' }, {}),
      text('t', '### Three'),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
  });
});

describe('a11y-landmark', () => {
  const doc: PolicyDocument = {
    baseline: [{ id: 'l', check: 'has-landmark', severity: 'warn', action: 'requireApproval', message: 'no landmark' }],
  };

  it('fires once at the root when the tree has no landmark', () => {
    const root = column('r', [text('t', 'hello'), column('c', [text('d', 'world')])]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries.map((entry) => entry.nodePath)).toEqual(['<root>']);
  });

  it('stays silent when a landmark exists anywhere in the tree', () => {
    const root = column('r', [
      column('header', [
        makeNode('nav', 'Navigation', { accessibility: { role: 'navigation' } }, {}),
      ]),
      text('t', 'content'),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([]);
  });

  it('matches landmark roles case-insensitively and rejects non-landmark roles', () => {
    const withMain = column('r', [makeNode('m', 'Region', { accessibility: { role: 'Main' } }, {})]);
    expect(evaluatePolicy(compilePolicy(doc), withMain).entries).toEqual([]);
    const withButtonRole = column('r', [makeNode('b', 'X', { accessibility: { role: 'button' } }, {})]);
    expect(evaluatePolicy(compilePolicy(doc), withButtonRole).entries).toHaveLength(1);
    const withBrokenMeta = column('r', [makeNode('b', 'X', { accessibility: 'not-an-object' }, {})]);
    expect(evaluatePolicy(compilePolicy(doc), withBrokenMeta).entries).toHaveLength(1);
  });
});

describe('a11y-focus-order', () => {
  const doc: PolicyDocument = {
    baseline: [{ id: 'f', check: 'interactive-focusable', severity: 'warn', action: 'requireApproval', message: 'focusable=false' }],
  };

  it('fires on interactive elements (props.action) declaring accessibility.focusable=false', () => {
    const root = column('r', [
      makeNode('b', 'Button', { action: { event: { name: 'go' } }, accessibility: { focusable: false } }, {}),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.nodePath).toBe('<root>/slots.content[0]');
  });

  it('stays silent for focusable defaults, non-interactive focusable=false and interactive without metadata', () => {
    const root = column('r', [
      makeNode('b1', 'Button', { action: { event: { name: 'go' } }, accessibility: { focusable: true } }, {}),
      makeNode('d', 'Decoration', { accessibility: { focusable: false } }, {}),
      makeNode('b2', 'Button', { action: { event: { name: 'stop' } } }, {}),
    ]);
    const result = evaluatePolicy(compilePolicy(doc), root);
    expect(result.entries).toEqual([]);
  });
});

describe('baseline a11y shadow behavior through gate (v2 7.3)', () => {
  it('records shadow entries without affecting the verdict or producing fix requests', () => {
    const compiled = compilePolicy(BASELINE_A11Y);
    // No landmark anywhere: the landmark rule must record a shadow hit, verdict stays pass.
    const root = column('r', [text('t', 'hello'), makeNode('b', 'Button', { action: { event: { name: 'go' } }, accessibility: { focusable: false } }, {})]);
    const result = gate(root, { policy: (ir) => evaluatePolicy(compiled, ir) });
    const shadowEntries = result.trace.filter((entry: TraceEntry) => entry.shadowAction !== undefined);
    expect(shadowEntries.map((entry) => entry.ruleId).sort()).toEqual(['a11y-focus-order', 'a11y-landmark']);
    expect(shadowEntries.every((entry) => entry.action === 'pass')).toBe(true);
    expect(result.verdict).toBe('pass');
  });

  it('keeps the gate idempotent under the baseline preset (v2 15.0, >= 100 runs)', () => {
    const compiled = compilePolicy(BASELINE_A11Y);
    const leafArb = fc.record({
      type: fc.constantFrom('Text', 'Button'),
      text: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
      hasAction: fc.boolean(),
      role: fc.option(fc.constantFrom('main', 'Main', 'button'), { nil: undefined }),
      focusableFalse: fc.boolean(),
    });
    const leafNodeArb = leafArb.map((leaf): IRNode => {
      const props: JsonObject = {};
      if (leaf.text !== undefined) props['text'] = leaf.text;
      if (leaf.hasAction) props['action'] = { event: { name: 'go' } };
      const meta: JsonObject = {};
      if (leaf.role !== undefined) meta['role'] = leaf.role;
      if (leaf.focusableFalse) meta['focusable'] = false;
      if (Object.keys(meta).length > 0) props['accessibility'] = meta;
      return makeNode('leaf', leaf.type, props, {});
    });
    const treeArb = fc
      .array(leafNodeArb, { minLength: 1, maxLength: 5 })
      .chain((leaves) => fc.constant(column('root', [text('h', '# A'), ...leaves, text('h2', '### B')])));
    const property = fc.property(treeArb, (ir) => {
      const first = gate(ir, { policy: (tree) => evaluatePolicy(compiled, tree) });
      const second = gate(first.ir, { policy: (tree) => evaluatePolicy(compiled, tree) });
      expect(specHash(second.ir)).toBe(specHash(first.ir));
      expect(second.verdict).toBe(projectVerdict(first.verdict));
    });
    fc.assert(property, { numRuns: 100 });
  });
});
