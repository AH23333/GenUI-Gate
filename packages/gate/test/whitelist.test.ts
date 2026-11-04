import type { IRNode } from '@genui/ir';
import { describe, expect, it } from 'vitest';
import { gate } from '../src/gate';
import type { Catalog } from '../src/schema';
import { checkWhitelist } from '../src/whitelist';

function leaf(id: string, type: string): IRNode {
  return { id, type, props: {}, slots: {} };
}

const catalog: Catalog = {
  Row: { propsSchema: { type: 'object' } },
  Text: { propsSchema: { type: 'object' } },
};

describe('checkWhitelist', () => {
  it('passes when every component type is in the catalog', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: {},
      slots: { default: [leaf('t1', 'Text'), leaf('t2', 'Text')] },
    };
    expect(checkWhitelist(ir, catalog)).toEqual([]);
  });

  it('blocks an unknown top-level component type as critical', () => {
    const violations = checkWhitelist(leaf('x', 'Spinner'), catalog);
    expect(violations).toEqual([
      {
        ruleId: 'whitelist.unknown-component',
        severity: 'critical',
        action: 'block',
        nodePath: '<root>',
        message: 'component type "Spinner" is not in the catalog whitelist',
      },
    ]);
  });

  it('finds unknown types deep in slots at the exact path', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: {},
      slots: {
        default: [
          {
            id: 'mid',
            type: 'Row',
            props: {},
            slots: { footer: [leaf('bad', 'Marquee')] },
          },
        ],
      },
    };
    const violations = checkWhitelist(ir, catalog);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      nodePath: '<root>/slots.default[0]/slots.footer[0]',
      severity: 'critical',
      action: 'block',
    });
  });

  it('flags every unknown node independently', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: {},
      slots: { default: [leaf('a', 'Spinner'), leaf('b', 'Spinner')] },
    };
    expect(checkWhitelist(ir, catalog)).toHaveLength(2);
  });

  it('treats an empty catalog as rejecting everything', () => {
    expect(checkWhitelist(leaf('x', 'Text'), {})).toHaveLength(1);
  });
});

describe('gate integration (whitelist stage)', () => {
  it('blocks unknown component types end-to-end', () => {
    const result = gate(
      { id: 'root', type: 'Row', props: {}, slots: { default: [leaf('bad', 'Spinner')] } },
      { catalog },
    );
    expect(result.verdict).toBe('block');
    expect(result.trace.at(-1)).toMatchObject({ ruleId: 'whitelist.unknown-component', severity: 'critical' });
  });
});
