import { canonicalize, isJsonValue, type IRNode, type JsonObject, type JsonValue } from '@genui/ir';
import type { TraceEntry } from './types';

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonSchemaSubset {
  type?: SchemaType;
  const?: JsonValue;
  enum?: JsonValue[];
  required?: string[];
  properties?: Record<string, JsonSchemaSubset>;
  additionalProperties?: false;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

export interface CatalogEntry {
  propsSchema: JsonSchemaSubset;
}

export type Catalog = Record<string, CatalogEntry>;

export const MAX_SCHEMA_DEPTH = 8;

export class SchemaManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaManifestError';
  }
}

export interface SchemaIssue {
  path: string;
  keyword: string;
  message: string;
}

const ALLOWED_KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
]);

const SCHEMA_TYPES = new Set<SchemaType>(['object', 'array', 'string', 'number', 'boolean', 'null']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkSchemaShape(schema: JsonSchemaSubset, path: string, depth: number, errors: string[]): void {
  if (!isPlainObject(schema)) {
    errors.push(`${path}: schema must be an object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      errors.push(`${path}: unsupported keyword "${key}" (subset: type/const/enum/required/properties/additionalProperties/minimum/maximum/minLength/maxLength/maxItems)`);
    }
  }
  const type = (schema as Record<string, unknown>)['type'];
  if (type !== undefined && (typeof type !== 'string' || !SCHEMA_TYPES.has(type as SchemaType))) {
    errors.push(`${path}.type: must be one of object|array|string|number|boolean|null`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      errors.push(`${path}.enum: must be a non-empty array`);
    } else if (!schema.enum.every((candidate) => isJsonValue(candidate))) {
      errors.push(`${path}.enum: entries must be JSON values`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length === 0) {
      errors.push(`${path}.required: must be a non-empty array`);
    } else if (!schema.required.every((key) => typeof key === 'string' && key.length > 0)) {
      errors.push(`${path}.required: entries must be non-empty strings`);
    }
  }
  if (schema.minimum !== undefined && (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum))) {
    errors.push(`${path}.minimum: must be a finite number`);
  }
  if (schema.maximum !== undefined && (typeof schema.maximum !== 'number' || !Number.isFinite(schema.maximum))) {
    errors.push(`${path}.maximum: must be a finite number`);
  }
  if (schema.minLength !== undefined && (typeof schema.minLength !== 'number' || !Number.isInteger(schema.minLength) || schema.minLength < 0)) {
    errors.push(`${path}.minLength: must be a non-negative integer`);
  }
  if (schema.maxLength !== undefined && (typeof schema.maxLength !== 'number' || !Number.isInteger(schema.maxLength) || schema.maxLength < 0)) {
    errors.push(`${path}.maxLength: must be a non-negative integer`);
  }
  if (schema.maxItems !== undefined && (typeof schema.maxItems !== 'number' || !Number.isInteger(schema.maxItems) || schema.maxItems < 0)) {
    errors.push(`${path}.maxItems: must be a non-negative integer`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    errors.push(`${path}.additionalProperties: only "false" is supported`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push(`${path}: schema nesting exceeds max depth ${MAX_SCHEMA_DEPTH}`);
    return;
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      errors.push(`${path}.properties: must be an object`);
    } else {
      for (const key of Object.keys(schema.properties)) {
        const child = (schema.properties as Record<string, unknown>)[key];
        checkSchemaShape(child as JsonSchemaSubset, `${path}.properties.${key}`, depth + 1, errors);
      }
    }
  }
}

export function schemaShapeErrors(schema: JsonSchemaSubset): string[] {
  const errors: string[] = [];
  checkSchemaShape(schema, '<propsSchema>', 1, errors);
  return errors;
}

export function validateCatalog(catalog: Catalog): void {
  const errors: string[] = [];
  for (const componentId of Object.keys(catalog)) {
    const entry = catalog[componentId];
    if (!isPlainObject(entry)) {
      errors.push(`component "${componentId}": entry must be an object`);
      continue;
    }
    const schema = (entry as Record<string, unknown>)['propsSchema'];
    if (schema === undefined) {
      errors.push(`component "${componentId}": missing propsSchema`);
      continue;
    }
    checkSchemaShape(schema as JsonSchemaSubset, `${componentId}.propsSchema`, 1, errors);
  }
  if (errors.length > 0) {
    throw new SchemaManifestError(`invalid catalog manifest: ${errors.join('; ')}`);
  }
}

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

function jsonTypeOf(value: JsonValue): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  if (kind === 'object') return 'object';
  return kind as SchemaType;
}

function canonicalEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalize(a) === canonicalize(b);
}

function validateValue(schema: JsonSchemaSubset, value: JsonValue, path: string, issues: SchemaIssue[], depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push({ path, keyword: 'type', message: `schema nesting exceeds max depth ${MAX_SCHEMA_DEPTH}` });
    return;
  }
  if (!isJsonValue(value)) {
    issues.push({ path, keyword: 'type', message: 'value is not a JSON value' });
    return;
  }
  if (schema.type !== undefined) {
    const actual = jsonTypeOf(value);
    if (actual !== schema.type) {
      issues.push({ path, keyword: 'type', message: `expected ${schema.type}, got ${actual}` });
      return;
    }
  }
  if (schema.const !== undefined && !canonicalEqual(value, schema.const)) {
    issues.push({ path, keyword: 'const', message: 'value does not match const' });
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => canonicalEqual(value, candidate))) {
    issues.push({ path, keyword: 'enum', message: 'value does not match any enum entry' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, keyword: 'minimum', message: `value ${value} is below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, keyword: 'maximum', message: `value ${value} is above maximum ${schema.maximum}` });
    }
  }
  if (typeof value === 'string') {
    const length = codePointLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push({ path, keyword: 'minLength', message: `string length ${length} is below minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push({ path, keyword: 'maxLength', message: `string length ${length} is above maxLength ${schema.maxLength}` });
    }
  }
  if (Array.isArray(value) && schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push({ path, keyword: 'maxItems', message: `array has ${value.length} items, maxItems ${schema.maxItems}` });
  }
  if (isPlainObject(value) && schema.properties !== undefined) {
    const properties = schema.properties;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        issues.push({ path, keyword: 'required', message: `missing required property "${key}"` });
      }
    }
    for (const key of Object.keys(value)) {
      const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: `property "${key}" is not allowed` });
        }
        continue;
      }
      validateValue(childSchema, value[key] as JsonValue, `${path}.${key}`, issues, depth + 1);
    }
  }
}

export function validateProps(schema: JsonSchemaSubset, props: JsonObject): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  for (const key of Object.keys(props)) {
    const childSchema = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key]! : undefined;
    if (childSchema === undefined) {
      if (schema.additionalProperties === false) {
        issues.push({ path: key, keyword: 'additionalProperties', message: `property "${key}" is not allowed` });
      }
      continue;
    }
    validateValue(childSchema, props[key] as JsonValue, key, issues, 1);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(props, key)) {
      issues.push({ path: key, keyword: 'required', message: `missing required property "${key}"` });
    }
  }
  return issues;
}

interface Frame {
  node: IRNode;
  path: string;
}

export function checkSchema(root: IRNode, catalog: Catalog): TraceEntry[] {
  const violations: TraceEntry[] = [];
  const stack: Frame[] = [{ node: root, path: '<root>' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, path } = frame;
    const entry = catalog[node.type];
    if (entry !== undefined) {
      const issues = validateProps(entry.propsSchema, node.props);
      for (const issue of issues) {
        violations.push({
          ruleId: `schema.${issue.keyword}`,
          severity: 'error',
          action: 'block',
          nodePath: `${path}.props.${issue.path}`,
          message: issue.message,
        });
      }
    }

    for (const slotName of Object.keys(node.slots)) {
      const children = node.slots[slotName]!;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i]!, path: `${path}/slots.${slotName}[${i}]` });
      }
    }
  }

  return violations;
}
