import type { BindingRef, IRNode, JsonObject, JsonValue } from '@genui/ir';
import { pointerSet, PointerError } from './pointer';
import { parseA2UISpec } from './parse';
import type {
  AdapterIssue,
  AdapterResult,
  A2UIMessage,
  SurfaceSnapshot,
} from './types';

type RawComponent = Record<string, unknown>;

interface SurfaceState {
  surfaceId: string;
  catalogId?: string;
  versions: string[];
  components: Map<string, RawComponent>;
  dataModel: Record<string, unknown>;
  deleted: boolean;
}

const BINDING_SCAN_BUDGET = 100_000;

const PROPS_EXCLUDED = new Set(['id', 'component', 'child', 'children']);

function clone(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!isPlainJson(value)) return null;
  return value as JsonObject;
}

function isPlainJson(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) continue;
    if (typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(current);
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push((current as Record<string, unknown>)[keys[i]!]);
    }
  }
  return true;
}

function collectBindings(value: unknown, source: string, out: BindingRef[]): void {
  let budget = BINDING_SCAN_BUDGET;
  const stack: unknown[] = [value];
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop();
    budget -= 1;
    if (current === null) continue;
    if (typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === '@path' && typeof record['@path'] === 'string') {
      out.push({ source, path: record['@path'] });
      continue;
    }
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push(record[keys[i]!]);
    }
  }
}

function buildProps(raw: RawComponent): JsonObject {
  const props: JsonObject = {};
  for (const key of Object.keys(raw)) {
    if (PROPS_EXCLUDED.has(key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    props[key] = value as JsonValue;
  }
  return props;
}

interface EnterTask {
  kind: 'enter';
  raw: RawComponent;
  parent: IRNode | null;
  slotName?: string;
  slotIndex?: number;
}

interface ExitTask {
  kind: 'exit';
  id: string;
  node: IRNode;
}

type Task = EnterTask | ExitTask;

function buildTree(
  components: Map<string, RawComponent>,
  surfaceId: string,
  issues: AdapterIssue[],
): IRNode | null {
  const rootRaw = components.get('root');
  if (rootRaw === undefined) {
    issues.push({
      code: 'missing-root',
      message: 'surface has no component with id "root"',
      surfaceId,
    });
    return null;
  }

  const tasks: Task[] = [{ kind: 'enter', raw: rootRaw, parent: null }];
  const onPath = new Set<string>();
  let rootNode: IRNode | null = null;

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === 'exit') {
      onPath.delete(task.id);
      compactSlots(task.node);
      continue;
    }
    const { raw, parent, slotName, slotIndex } = task;
    const id = raw['id'] as string;
    if (onPath.has(id)) {
      issues.push({
        code: 'child-cycle',
        message: `component "${id}" participates in a reference cycle`,
        surfaceId,
        componentId: id,
      });
      continue;
    }
    onPath.add(id);

    const type = typeof raw['component'] === 'string' ? raw['component'] : '';
    const props = buildProps(raw);
    const childrenRaw = raw['children'];
    if (
      typeof childrenRaw === 'object' &&
      childrenRaw !== null &&
      !Array.isArray(childrenRaw)
    ) {
      props['children'] = childrenRaw as JsonValue;
    }
    const node: IRNode = { id, type, props, slots: {} };
    const bindings = collectNodeBindings(node, raw, surfaceId);
    if (bindings.length > 0) node.bindings = bindings;

    if (parent === null) {
      rootNode = node;
    } else {
      parent.slots[slotName!]![slotIndex!] = node;
    }

    tasks.push({ kind: 'exit', id, node });

    const pending: EnterTask[] = [];
    collectChildRefs(raw, surfaceId, node, issues, pending, components);
    for (let i = pending.length - 1; i >= 0; i--) {
      tasks.push(pending[i]!);
    }
  }

  return rootNode;
}

function compactSlots(node: IRNode): void {
  for (const slotName of Object.keys(node.slots)) {
    const slot = node.slots[slotName]!;
    let write = 0;
    for (let read = 0; read < slot.length; read++) {
      const child = slot[read];
      if (child !== null && child !== undefined) {
        slot[write] = child;
        write += 1;
      }
    }
    slot.length = write;
  }
}

function collectNodeBindings(node: IRNode, raw: RawComponent, surfaceId: string): BindingRef[] {
  const bindings: BindingRef[] = [];
  collectBindings(node.props, surfaceId, bindings);
  const children = raw['children'];
  if (typeof children === 'object' && children !== null && !Array.isArray(children)) {
    const template = children as Record<string, unknown>;
    const path = template['path'];
    if (typeof path === 'string') {
      bindings.push({ source: surfaceId, path });
    }
  }
  return bindings;
}

function collectChildRefs(
  raw: RawComponent,
  surfaceId: string,
  node: IRNode,
  issues: AdapterIssue[],
  pending: EnterTask[],
  components: Map<string, RawComponent>,
): void {
  const childRef = raw['child'];
  if (childRef !== undefined) {
    if (typeof childRef !== 'string') {
      issues.push({
        code: 'invalid-child-ref',
        message: '"child" is not a component id string',
        surfaceId,
        componentId: node.id,
      });
    } else {
      node.slots['child'] = [null as unknown as IRNode];
      pushChild(childRef, node, 'child', 0, surfaceId, issues, pending, components);
    }
  }

  const children = raw['children'];
  if (children === undefined) return;
  if (typeof children === 'object' && children !== null && !Array.isArray(children)) {
    return;
  }
  if (!Array.isArray(children)) {
    issues.push({
      code: 'invalid-child-ref',
      message: '"children" is neither an array of ids nor a template object',
      surfaceId,
      componentId: node.id,
    });
    return;
  }
  node.slots['children'] = [];
  for (let i = 0; i < children.length; i++) {
    const ref = children[i];
    if (typeof ref !== 'string') {
      issues.push({
        code: 'invalid-child-ref',
        message: `"children[${i}]" is not a component id string`,
        surfaceId,
        componentId: node.id,
      });
      continue;
    }
    const slotIndex = node.slots['children'].length;
    node.slots['children'].push(null as unknown as IRNode);
    pushChild(ref, node, 'children', slotIndex, surfaceId, issues, pending, components);
  }
}

function pushChild(
  ref: string,
  parent: IRNode,
  slotName: string,
  slotIndex: number,
  surfaceId: string,
  issues: AdapterIssue[],
  pending: EnterTask[],
  components: Map<string, RawComponent>,
): void {
  const childRaw = components.get(ref);
  if (childRaw === undefined) {
    issues.push({
      code: 'dangling-child-ref',
      message: `child reference "${ref}" does not match any component`,
      surfaceId,
      componentId: ref,
    });
    return;
  }
  pending.push({ kind: 'enter', raw: childRaw, parent, slotName, slotIndex });
}

/**
 * Incremental A2UI → IR translation session. Feed it parsed messages;
 * take a deterministic snapshot at any point. `reset()` + replay is the
 * resync path (v2 §5.2): a fresh createSurface stream rebuilds every surface.
 */
export class A2UISession {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly issues: AdapterIssue[] = [];

  apply(message: A2UIMessage): void {
    switch (message.kind) {
      case 'createSurface':
        this.applyCreateSurface(message);
        break;
      case 'updateComponents':
        this.applyUpdateComponents(message);
        break;
      case 'updateDataModel':
        this.applyUpdateDataModel(message);
        break;
      case 'deleteSurface':
        this.applyDeleteSurface(message);
        break;
      case 'callRendererFunction':
      case 'agentFunctionResponse':
        this.recordVersion(message);
        break;
    }
  }

  applyAll(messages: A2UIMessage[]): void {
    for (const message of messages) this.apply(message);
  }

  reset(): void {
    this.surfaces.clear();
    this.issues.length = 0;
  }

  snapshot(): AdapterResult {
    const surfaces: SurfaceSnapshot[] = [];
    const treeIssues: AdapterIssue[] = [];
    for (const state of this.surfaces.values()) {
      const ir = buildTree(state.components, state.surfaceId, treeIssues);
      surfaces.push({
        surfaceId: state.surfaceId,
        ...(state.catalogId !== undefined ? { catalogId: state.catalogId } : {}),
        versions: [...state.versions],
        dataModel: state.dataModel,
        ir,
        deleted: state.deleted,
        componentCount: state.components.size,
      });
    }
    return { surfaces, issues: [...this.issues, ...treeIssues] };
  }

  private recordVersion(message: A2UIMessage): void {
    if (message.version === undefined) return;
    const surfaceId = message.payload['surfaceId'];
    if (typeof surfaceId !== 'string') return;
    const state = this.surfaces.get(surfaceId);
    if (state === undefined) return;
    if (!state.versions.includes(message.version)) state.versions.push(message.version);
  }

  private applyCreateSurface(message: A2UIMessage): void {
    const payload = message.payload;
    const surfaceId = payload['surfaceId'];
    if (typeof surfaceId !== 'string' || surfaceId === '') {
      this.pushIssue(message, {
        code: 'invalid-surface-id',
        message: '"createSurface.surfaceId" is missing or not a non-empty string',
      });
      return;
    }
    const existing = this.surfaces.get(surfaceId);
    if (existing !== undefined && !existing.deleted) {
      this.pushIssue(message, {
        code: 'surface-already-exists',
        message: `surface "${surfaceId}" already exists`,
        surfaceId,
      });
      return;
    }
    const dataModelRaw = payload['dataModel'];
    let dataModel: Record<string, unknown> = {};
    if (dataModelRaw !== undefined) {
      const parsed = toJsonObject(dataModelRaw);
      if (parsed === null) {
        this.pushIssue(message, {
          code: 'invalid-data-model',
          message: '"createSurface.dataModel" is not a JSON object',
          surfaceId,
        });
      } else {
        dataModel = clone(parsed) as Record<string, unknown>;
      }
    }
    const catalogId = payload['catalogId'];
    const state: SurfaceState = {
      surfaceId,
      components: new Map(),
      dataModel,
      versions: [],
      deleted: false,
      ...(typeof catalogId === 'string' ? { catalogId } : {}),
    };
    if (message.version !== undefined) state.versions.push(message.version);
    this.surfaces.set(surfaceId, state);

    const components = payload['components'];
    if (components !== undefined) {
      this.upsertComponents(state, components, message);
    }
  }

  private applyUpdateComponents(message: A2UIMessage): void {
    const payload = message.payload;
    const surfaceId = payload['surfaceId'];
    const state = this.lookupSurface(surfaceId, message);
    if (state === undefined) return;
    this.upsertComponents(state, payload['components'], message);
  }

  private applyUpdateDataModel(message: A2UIMessage): void {
    const payload = message.payload;
    const surfaceId = payload['surfaceId'];
    const state = this.lookupSurface(surfaceId, message);
    if (state === undefined) return;
    const path = payload['path'];
    let pointer = '';
    if (path !== undefined) {
      if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
        this.pushIssue(message, {
          code: 'invalid-data-model',
          message: '"updateDataModel.path" is not a JSON pointer',
          surfaceId: state.surfaceId,
        });
        return;
      }
      pointer = path;
    }
    if (!('value' in payload)) {
      this.pushIssue(message, {
        code: 'invalid-data-model',
        message: '"updateDataModel.value" is missing',
        surfaceId: state.surfaceId,
      });
      return;
    }
    const value = payload['value'];
    if (value !== undefined && !isPlainJson(value)) {
      this.pushIssue(message, {
        code: 'invalid-data-model',
        message: '"updateDataModel.value" is not a plain JSON value',
        surfaceId: state.surfaceId,
      });
      return;
    }
    try {
      if (pointer === '' || pointer === '/') {
        const root = toJsonObject(value);
        if (root === null) {
          this.pushIssue(message, {
            code: 'invalid-data-model',
            message: 'whole-model update value is not a JSON object',
            surfaceId: state.surfaceId,
          });
          return;
        }
        state.dataModel = clone(root) as Record<string, unknown>;
        return;
      }
      pointerSet(state.dataModel, pointer, value === undefined ? null : clone(value as JsonValue));
    } catch (error) {
      if (error instanceof PointerError) {
        this.pushIssue(message, {
          code: 'invalid-data-model',
          message: `data model update failed: ${error.message}`,
          surfaceId: state.surfaceId,
        });
        return;
      }
      throw error;
    }
  }

  private applyDeleteSurface(message: A2UIMessage): void {
    const payload = message.payload;
    const surfaceId = payload['surfaceId'];
    const state = this.lookupSurface(surfaceId, message);
    if (state === undefined) return;
    state.deleted = true;
  }

  private lookupSurface(surfaceId: unknown, message: A2UIMessage): SurfaceState | undefined {
    if (typeof surfaceId !== 'string' || surfaceId === '') {
      this.pushIssue(message, {
        code: 'invalid-surface-id',
        message: `"${message.kind}.surfaceId" is missing or not a non-empty string`,
      });
      return undefined;
    }
    const state = this.surfaces.get(surfaceId);
    if (state === undefined || state.deleted) {
      this.pushIssue(message, {
        code: 'unknown-surface',
        message: `surface "${surfaceId}" does not exist`,
        surfaceId,
      });
      return undefined;
    }
    if (message.version !== undefined && !state.versions.includes(message.version)) {
      state.versions.push(message.version);
    }
    return state;
  }

  private upsertComponents(state: SurfaceState, raw: unknown, message: A2UIMessage): void {
    if (!Array.isArray(raw) || raw.length === 0) {
      this.pushIssue(message, {
        code: 'invalid-components',
        message: '"components" is missing or not a non-empty array',
        surfaceId: state.surfaceId,
      });
      return;
    }
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        this.pushIssue(message, {
          code: 'invalid-components',
          message: 'components entry is not a JSON object',
          surfaceId: state.surfaceId,
        });
        continue;
      }
      const component = entry as RawComponent;
      const id = component['id'];
      if (typeof id !== 'string' || id === '') {
        this.pushIssue(message, {
          code: 'missing-component-id',
          message: 'component is missing a non-empty string "id"',
          surfaceId: state.surfaceId,
        });
        continue;
      }
      if (typeof component['component'] !== 'string') {
        this.pushIssue(message, {
          code: 'missing-component-type',
          message: `component "${id}" is missing a string "component" type`,
          surfaceId: state.surfaceId,
          componentId: id,
        });
      }
      if (seen.has(id)) {
        this.pushIssue(message, {
          code: 'duplicate-component-id',
          message: `component id "${id}" appears more than once in one update, last definition wins`,
          surfaceId: state.surfaceId,
          componentId: id,
        });
      }
      seen.add(id);
      state.components.set(id, component);
    }
  }

  private pushIssue(message: A2UIMessage, issue: AdapterIssue): void {
    const messageIndex = message.messageIndex;
    this.issues.push({
      ...issue,
      ...(messageIndex !== undefined ? { messageIndex } : {}),
    });
  }
}

/**
 * One-shot translation: A2UI spec text (JSONL, message array, example
 * wrapper, or single message) → IR snapshots + issues.
 */
export function adaptA2UI(input: string): AdapterResult {
  const parsed = parseA2UISpec(input);
  const session = new A2UISession();
  session.applyAll(parsed.messages);
  const result = session.snapshot();
  return {
    surfaces: result.surfaces,
    issues: [...parsed.issues, ...result.issues],
  };
}

/** One-shot translation over already-parsed messages. */
export function adaptA2UIMessages(messages: A2UIMessage[]): AdapterResult {
  const session = new A2UISession();
  session.applyAll(messages);
  return session.snapshot();
}
