import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { gate } from '../src/gate';
import {
  MAX_SCHEMA_DEPTH,
  SchemaManifestError,
  checkSchema,
  schemaShapeErrors,
  validateCatalog,
  validateProps,
  type Catalog,
  type JsonSchemaSubset,
} from '../src/schema';

function leaf(id: string, type: string, props: JsonObject): IRNode {
  return { id, type, props, slots: {} };
}

describe('schemaShapeErrors / validateCatalog (manifest compile, fail-closed)', () => {
  it('accepts the full supported subset at max depth', () => {
    let schema: JsonSchemaSubset = { type: 'string', minLength: 1, maxLength: 10 };
    for (let i = 0; i < MAX_SCHEMA_DEPTH - 1; i++) {
      schema = { type: 'object', required: ['v'], properties: { v: schema } };
    }
    expect(schemaShapeErrors(schema)).toEqual([]);
    expect(() => validateCatalog({ Deep: { propsSchema: schema } })).not.toThrow();
  });

  it('rejects schemas nesting deeper than the max depth', () => {
    let schema: JsonSchemaSubset = { type: 'string' };
    for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) {
      schema = { type: 'object', properties: { v: schema } };
    }
    const errors = schemaShapeErrors(schema);
    expect(errors.some((error) => error.includes('max depth'))).toBe(true);
    expect(() => validateCatalog({ TooDeep: { propsSchema: schema } })).toThrow(SchemaManifestError);
  });

  it('rejects unsupported keywords ($ref / format / pattern / items)', () => {
    for (const extra of [{ $ref: '#/x' }, { format: 'email' }, { pattern: '^a' }, { items: { type: 'string' } }]) {
      const schema = { type: 'object', ...extra } as unknown as JsonSchemaSubset;
      const errors = schemaShapeErrors(schema);
      expect(errors.some((error) => error.includes('unsupported keyword'))).toBe(true);
      expect(() => validateCatalog({ Bad: { propsSchema: schema } })).toThrow(SchemaManifestError);
    }
  });

  it('rejects additionalProperties: true (only false is supported)', () => {
    const schema = { type: 'object', additionalProperties: true } as unknown as JsonSchemaSubset;
    expect(schemaShapeErrors(schema).some((error) => error.includes('additionalProperties'))).toBe(true);
  });

  it('rejects malformed keyword values', () => {
    const cases: JsonSchemaSubset[] = [
      { type: 'widget' } as unknown as JsonSchemaSubset,
      { required: [42] } as unknown as JsonSchemaSubset,
      { minLength: -1 },
      { maxItems: 1.5 },
      { enum: [] },
    ];
    for (const schema of cases) {
      expect(schemaShapeErrors(schema).length).toBeGreaterThan(0);
    }
  });

  it('validateCatalog collects all component errors into one message', () => {
    const catalog: Catalog = {
      Good: { propsSchema: { type: 'object', properties: { a: { type: 'string' } } } },
      Bad1: { propsSchema: { $ref: '#/x' } as unknown as JsonSchemaSubset },
      Bad2: { propsSchema: { minLength: 'nope' } as unknown as JsonSchemaSubset },
    };
    try {
      validateCatalog(catalog);
      expect.unreachable('validateCatalog should have thrown');
    } catch (error) {
      const message = (error as SchemaManifestError).message;
      expect(message).toContain('Bad1');
      expect(message).toContain('Bad2');
      expect(message).not.toContain('Good');
    }
  });

  it('rejects catalog entries missing propsSchema', () => {
    expect(() => validateCatalog({ NoSchema: {} as never })).toThrow(/missing propsSchema/);
  });

  it('rejects catalog entries that are not objects (hostile catalog)', () => {
    expect(() => validateCatalog({ NotAnObject: null as never })).toThrow(/entry must be an object/);
    expect(() => validateCatalog({ AlsoBad: 'nope' as never })).toThrow(/entry must be an object/);
  });

  it('validateProps stays fail-safe on an unvalidated overly deep schema (no stack overflow)', () => {
    let schema: JsonSchemaSubset = { type: 'string' };
    for (let i = 0; i < MAX_SCHEMA_DEPTH * 20; i++) {
      schema = { type: 'object', properties: { v: schema } };
    }
    const issues = validateProps(schema, {});
    expect(issues).toEqual([]);
    let value: { v?: unknown } = {};
    const head: { v?: unknown } = value;
    for (let i = 0; i <= MAX_SCHEMA_DEPTH; i++) {
      const next: { v?: unknown } = {};
      value.v = next;
      value = next;
    }
    const nestedIssues = validateProps(schema, (head as unknown) as JsonObject);
    expect(nestedIssues.some((issue) => issue.message.includes('max depth'))).toBe(true);
  });
});

describe('validateProps (JSON Schema subset)', () => {
  it('flags missing required properties', () => {
    const schema: JsonSchemaSubset = { type: 'object', required: ['label'], properties: { label: { type: 'string' } } };
    expect(validateProps(schema, {})).toEqual([
      { path: 'label', keyword: 'required', message: 'missing required property "label"' },
    ]);
  });

  it('flags type mismatches', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { count: { type: 'number' }, tags: { type: 'array' } } };
    const issues = validateProps(schema, { count: 'three', tags: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'count', keyword: 'type' });
  });

  it('matches const and enum via canonical equality (key-order insensitive)', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      properties: {
        mode: { const: 'fast' },
        style: { enum: [{ color: 'red', bold: true }, 'plain'] },
      },
    };
    expect(validateProps(schema, { mode: 'fast', style: { bold: true, color: 'red' } })).toEqual([]);
    expect(validateProps(schema, { mode: 'slow', style: { color: 'red', bold: false } })).toHaveLength(2);
  });

  it('enforces numeric bounds', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { gap: { type: 'number', minimum: 0, maximum: 64 } } };
    expect(validateProps(schema, { gap: 0 })).toEqual([]);
    expect(validateProps(schema, { gap: 64 })).toEqual([]);
    expect(validateProps(schema, { gap: -1 })[0]).toMatchObject({ keyword: 'minimum' });
    expect(validateProps(schema, { gap: 65 })[0]).toMatchObject({ keyword: 'maximum' });
  });

  it('enforces string length bounds by code points (surrogate pair counts once)', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { label: { type: 'string', minLength: 2, maxLength: 4 } } };
    expect(validateProps(schema, { label: '😀😀' })).toEqual([]);
    expect(validateProps(schema, { label: '😀' })[0]).toMatchObject({ keyword: 'minLength' });
    expect(validateProps(schema, { label: '😀😀😀' })).toEqual([]);
    expect(validateProps(schema, { label: 'abcde' })[0]).toMatchObject({ keyword: 'maxLength' });
  });

  it('enforces maxItems on arrays', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { tags: { type: 'array', maxItems: 2 } } };
    expect(validateProps(schema, { tags: ['a', 'b'] })).toEqual([]);
    expect(validateProps(schema, { tags: ['a', 'b', 'c'] })[0]).toMatchObject({ keyword: 'maxItems' });
  });

  it('rejects unknown properties only when additionalProperties is false', () => {
    const strict: JsonSchemaSubset = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const lax: JsonSchemaSubset = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateProps(strict, { b: 1 })[0]).toMatchObject({ keyword: 'additionalProperties' });
    expect(validateProps(lax, { b: 1 })).toEqual([]);
  });

  it('validates nested objects recursively', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      properties: {
        style: {
          type: 'object',
          required: ['color'],
          properties: { color: { type: 'string' } },
        },
      },
    };
    expect(validateProps(schema, { style: { color: 'red' } })).toEqual([]);
    expect(validateProps(schema, { style: { bold: true } })[0]).toMatchObject({ keyword: 'required' });
  });

  it('flags non-finite numbers as type violations (JSON has no NaN/Infinity)', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { x: { type: 'number' } } };
    const issues = validateProps(schema, { x: Number.NaN });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ keyword: 'type' });
  });

  it('rejects unknown keys in nested objects when additionalProperties is false', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      properties: {
        style: {
          type: 'object',
          properties: { color: { type: 'string' } },
          additionalProperties: false,
        },
      },
    };
    expect(validateProps(schema, { style: { color: 'red', bold: true } })).toEqual([
      { path: 'style.bold', keyword: 'additionalProperties', message: 'property "bold" is not allowed' },
    ]);
  });
});

describe('checkSchema (IR walk)', () => {
  const catalog: Catalog = {
    Text: { propsSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
  };

  it('flags schema violations per node with error/block', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: {},
      slots: { default: [leaf('t1', 'Text', { content: 42 }), leaf('t2', 'Text', {})] },
    };
    const violations = checkSchema(ir, catalog);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({
      ruleId: 'schema.type',
      severity: 'error',
      action: 'block',
      nodePath: '<root>/slots.default[0].props.content',
    });
    expect(violations[1]).toMatchObject({ ruleId: 'schema.required', nodePath: '<root>/slots.default[1].props.content' });
  });

  it('skips components without a catalog entry (whitelist stage owns unknowns)', () => {
    expect(checkSchema(leaf('r', 'Row', { anything: 1 }), catalog)).toEqual([]);
  });
});

describe('gate pipeline with catalog (limits -> schema -> whitelist)', () => {
  const catalog: Catalog = {
    Text: { propsSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string', maxLength: 8 } } } },
    Row: { propsSchema: { type: 'object', properties: { gap: { type: 'number' } }, additionalProperties: false } },
  };

  it('emits trace entries in fixed stage order and blocks', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: { surprise: true, gap: 'x' },
      slots: { default: [leaf('t1', 'Text', { content: 'abcdefghijk' }), leaf('bad', 'Spinner', {})] },
    };
    const result = gate(ir, { catalog });
    expect(result.verdict).toBe('block');
    const stages = result.trace.map((entry) => entry.ruleId.split('.')[0]);
    expect(stages).toEqual(['schema', 'schema', 'schema', 'whitelist']);
    expect(result.trace[0]).toMatchObject({ ruleId: 'schema.additionalProperties' });
    expect(result.trace[1]).toMatchObject({ ruleId: 'schema.type', nodePath: '<root>.props.gap' });
    expect(result.trace[2]).toMatchObject({ ruleId: 'schema.maxLength', nodePath: '<root>/slots.default[0].props.content' });
    expect(result.trace[3]).toMatchObject({ ruleId: 'whitelist.unknown-component', severity: 'critical' });
  });

  it('passes a clean tree against the catalog', () => {
    const ir: IRNode = {
      id: 'root',
      type: 'Row',
      props: { gap: 8 },
      slots: { default: [leaf('t1', 'Text', { content: 'hi' })] },
    };
    const result = gate(ir, { catalog });
    expect(result.trace).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it('without a catalog behaves exactly as before (limits only)', () => {
    const ir: IRNode = leaf('x', 'Unknown', { a: 1 });
    const result = gate(ir);
    expect(result.trace).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it('throws SchemaManifestError on a malformed catalog (fail-closed)', () => {
    const badCatalog: Catalog = { X: { propsSchema: { pattern: '^a' } as unknown as JsonSchemaSubset } };
    expect(() => gate(leaf('x', 'X', {}), { catalog: badCatalog })).toThrow(SchemaManifestError);
  });
});

describe('deep-test properties (fast-check, >=100 runs)', () => {
  const arbitraryJsonValue: fc.Arbitrary<JsonValue> = fc.jsonValue() as fc.Arbitrary<JsonValue>;

  it('validateProps never throws on hostile prop values and is deterministic', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string', minLength: 1, maxLength: 5 },
        b: { type: 'number', minimum: 0, maximum: 10 },
        c: { type: 'object', required: ['d'], properties: { d: { type: 'array', maxItems: 3 } }, additionalProperties: false },
        e: { const: 'fixed' },
        f: { enum: ['x', 'y', 'z'] },
      },
      additionalProperties: false,
    };
    const arbitraryProps = fc
      .dictionary(fc.string({ minLength: 0, maxLength: 12 }), arbitraryJsonValue)
      .map((dict) => dict as JsonObject);

    fc.assert(
      fc.property(arbitraryProps, (props) => {
        const first = validateProps(schema, props);
        const second = validateProps(schema, props);
        expect(second).toEqual(first);
        for (const issue of first) {
          expect(typeof issue.path).toBe('string');
          expect(typeof issue.keyword).toBe('string');
          expect(typeof issue.message).toBe('string');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('validateProps: non-finite numbers in valid schemas never throw (NaN/Infinity hostile probe)', () => {
    const schema: JsonSchemaSubset = { type: 'object', properties: { x: { type: 'number', minimum: 0 } } };
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const issues = validateProps(schema, { x: hostile });
      expect(issues).toHaveLength(1);
      expect(issues[0]!.keyword).toBe('type');
    }
  });
});
