import type { IRNode } from '@genui/ir';
import { describe, expect, it } from 'vitest';
import { adaptA2UI, adaptA2UIMessages, A2UISession } from '../src/adapter';
import { parseA2UISpec } from '../src/parse';
import type { A2UIMessage } from '../src/types';

function msg(input: string): A2UIMessage {
  const parsed = parseA2UISpec(input);
  expect(parsed.issues).toEqual([]);
  expect(parsed.messages.length).toBe(1);
  return parsed.messages[0]!;
}

function countNodes(node: IRNode): number {
  let count = 0;
  const stack: IRNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    for (const slotName of Object.keys(current.slots)) {
      for (const child of current.slots[slotName]!) stack.push(child);
    }
  }
  return count;
}

const CREATE_MAIN =
  '{"version":"1.0","createSurface":{"surfaceId":"main","catalogId":"https://example.test/catalog.json"}}';

describe('A2UISession', () => {
  it('builds a tree from an updateComponents adjacency list', () => {
    const session = new A2UISession();
    session.applyAll([
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Column","children":["title","row"]},' +
          '{"id":"title","component":"Text","text":"# Hello"},' +
          '{"id":"row","component":"Row","children":["left","right"]},' +
          '{"id":"left","component":"Text","text":"L"},' +
          '{"id":"right","component":"Text","text":"R"},' +
          '{"id":"unused","component":"Text","text":"orphan"}]}}',
      ),
    ]);
    const snapshot = session.snapshot();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.surfaces.length).toBe(1);
    const surface = snapshot.surfaces[0]!;
    expect(surface.ir).not.toBeNull();
    expect(surface.componentCount).toBe(6);
    expect(countNodes(surface.ir!)).toBe(5);
    expect(surface.ir!.type).toBe('Column');
    expect(surface.ir!.slots['children']!.map((c) => c.id)).toEqual(['title', 'row']);
    expect(surface.ir!.slots['children']![1]!.slots['children']!.map((c) => c.id)).toEqual(['left', 'right']);
  });

  it('supports the v1.0 single-message instantiation', () => {
    const input =
      '{"version":"1.0","createSurface":{"surfaceId":"inline","components":[' +
      '{"id":"root","component":"Card","child":"body"},' +
      '{"id":"body","component":"Text","text":"inside"}],' +
      '"dataModel":{"user":{"name":"Ada"}}}}';
    const result = adaptA2UI(input);
    expect(result.issues).toEqual([]);
    expect(result.surfaces[0]!.ir!.type).toBe('Card');
    expect(result.surfaces[0]!.ir!.slots['child']![0]!.id).toBe('body');
    expect(result.surfaces[0]!.dataModel).toEqual({ user: { name: 'Ada' } });
  });

  it('keeps component-level envelope fields in props', () => {
    const input =
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
      '{"id":"root","component":"Button","accessibility":{"label":"Go"},"catalogId":"https://x.test/c.json",' +
      '"metadata":{"extensions":{"a2ui_telemetry":{"session":"1"}}}}]}}';
    const result = adaptA2UI(input);
    expect(result.surfaces[0]!.ir!.props).toEqual({
      accessibility: { label: 'Go' },
      catalogId: 'https://x.test/c.json',
      metadata: { extensions: { a2ui_telemetry: { session: '1' } } },
    });
  });

  it('records surface-level catalogId and every protocol version seen', () => {
    const session = new A2UISession();
    session.applyAll([
      msg(CREATE_MAIN),
      msg('{"version":"1.0","updateComponents":{"surfaceId":"main","components":[{"id":"root","component":"Text"}]}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","value":{}}}'),
      msg('{"version":"1.0","deleteSurface":{"surfaceId":"main"}}'),
    ]);
    const snapshot = session.snapshot();
    expect(snapshot.surfaces[0]!.catalogId).toBe('https://example.test/catalog.json');
    expect(snapshot.surfaces[0]!.versions).toEqual(['1.0']);
    expect(snapshot.surfaces[0]!.deleted).toBe(true);
    expect(snapshot.surfaces[0]!.ir).not.toBeNull();
  });

  it('reports a missing root', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[{"id":"a","component":"Text"}]}}',
    );
    expect(result.surfaces[0]!.ir).toBeNull();
    expect(result.issues).toEqual([
      { code: 'missing-root', message: 'surface has no component with id "root"', surfaceId: 's' },
    ]);
  });

  it('reports dangling child references and skips them', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Column","children":["a","ghost","b"]},' +
        '{"id":"a","component":"Text"},{"id":"b","component":"Text"}]}}',
    );
    const children = result.surfaces[0]!.ir!.slots['children']!;
    expect(children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.issues).toEqual([
      {
        code: 'dangling-child-ref',
        message: 'child reference "ghost" does not match any component',
        surfaceId: 's',
        componentId: 'ghost',
      },
    ]);
  });

  it('detects reference cycles and keeps the first occurrence', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Column","children":["a"]},' +
        '{"id":"a","component":"Column","children":["b"]},' +
        '{"id":"b","component":"Column","children":["a"]}]}}',
    );
    const a = result.surfaces[0]!.ir!.slots['children']![0]!;
    const b = a.slots['children']![0]!;
    expect(b.slots['children']).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(['child-cycle']);
    expect(result.issues[0]).toMatchObject({ surfaceId: 's', componentId: 'a' });
  });

  it('allows the same component to be referenced from two branches', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Column","children":["left","right"]},' +
        '{"id":"left","component":"Row","children":["shared"]},' +
        '{"id":"right","component":"Row","children":["shared"]},' +
        '{"id":"shared","component":"Text","text":"x"}]}}',
    );
    expect(result.issues).toEqual([]);
    const root = result.surfaces[0]!.ir!;
    const left = root.slots['children']![0]!;
    const right = root.slots['children']![1]!;
    expect(left.slots['children']![0]!.id).toBe('shared');
    expect(right.slots['children']![0]!.id).toBe('shared');
  });

  it('preserves ChildList templates in props and records their binding', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"List","children":{"componentId":"row","path":"/items"}},' +
        '{"id":"row","component":"Row","children":["cell"]},' +
        '{"id":"cell","component":"Text","text":{"@path":"name"}}]}}',
    );
    const root = result.surfaces[0]!.ir!;
    expect(root.slots).toEqual({});
    expect(root.props['children']).toEqual({ componentId: 'row', path: '/items' });
    expect(root.bindings).toEqual([{ source: 's', path: '/items' }]);
    expect(result.issues).toEqual([]);
  });

  it('collects @path bindings from nested props and function args', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"TextField","label":{"@path":"/labels/name"},' +
        '"value":{"@call":"formatString","args":{"value":"${/user/name}"}},' +
        '"checks":[{"condition":{"@call":"required","args":{"value":{"@path":"/user/name"}}},"message":"need"}]}]}}',
    );
    expect(result.surfaces[0]!.ir!.bindings).toEqual([
      { source: 's', path: '/labels/name' },
      { source: 's', path: '/user/name' },
    ]);
  });

  it('upserts components across updates and replaces definitions wholesale', () => {
    const session = new A2UISession();
    session.applyAll([
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Column","children":["a"]},{"id":"a","component":"Text","text":"one","extra":true}]}}',
      ),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"a","component":"Text","text":"two"}]}}',
      ),
    ]);
    const root = session.snapshot().surfaces[0]!.ir!;
    expect(root.slots['children']![0]!.props).toEqual({ text: 'two' });
    expect(session.snapshot().issues).toEqual([]);
  });

  it('reports duplicate ids inside one batch (last wins)', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Text","text":"first"},' +
        '{"id":"root","component":"Text","text":"second"}]}}',
    );
    expect(result.surfaces[0]!.ir!.props).toEqual({ text: 'second' });
    expect(result.issues.map((i) => i.code)).toEqual(['duplicate-component-id']);
  });

  it('reports surface lifecycle violations', () => {
    const session = new A2UISession();
    session.applyAll([
      msg('{"version":"1.0","updateComponents":{"surfaceId":"ghost","components":[{"id":"root","component":"Text"}]}}'),
      msg(CREATE_MAIN),
      msg(CREATE_MAIN),
      msg('{"version":"1.0","deleteSurface":{"surfaceId":"main"}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","value":{}}}'),
      msg('{"version":"1.0","deleteSurface":{"surfaceId":"main"}}'),
    ]);
    const snapshot = session.snapshot();
    expect(snapshot.issues.map((i) => i.code)).toEqual([
      'unknown-surface',
      'surface-already-exists',
      'unknown-surface',
      'unknown-surface',
      'missing-root',
    ]);
  });

  it('applies data model updates with JSON pointer upsert semantics', () => {
    const session = new A2UISession();
    session.applyAll([
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Text"}]}}',
      ),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","value":{"user":{"name":"Ada"},"list":[1,2]}}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","path":"/user/email","value":"a@b.c"}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","path":"/user/name","value":null}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","path":"/","value":{"fresh":true}}}'),
    ]);
    expect(session.snapshot().surfaces[0]!.dataModel).toEqual({ fresh: true });

    const session2 = new A2UISession();
    session2.applyAll([
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Text"}]}}',
      ),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","value":{"a":{"b":1}}}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","path":"/a/c","value":[1,2]}}'),
      msg('{"version":"1.0","updateDataModel":{"surfaceId":"main","path":"/a/c/1","value":9}}'),
    ]);
    expect(session2.snapshot().surfaces[0]!.dataModel).toEqual({ a: { b: 1, c: [1, 9] } });
    expect(session2.snapshot().issues).toEqual([]);
  });

  it('flags invalid components entries without dropping the valid ones', () => {
    const result = adaptA2UI(
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Text"},' +
        '{"id":""},' +
        '{"component":"NoId"},' +
        '{"id":"notype"},' +
        '"string-entry"]}}',
    );
    expect(result.surfaces[0]!.ir).not.toBeNull();
    expect(result.issues.map((i) => i.code)).toEqual([
      'missing-component-id',
      'missing-component-id',
      'missing-component-type',
      'invalid-components',
    ]);
  });

  it('ignores function messages but records versions for known surfaces', () => {
    const session = new A2UISession();
    session.applyAll([
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Text"}]}}',
      ),
      msg(
        '{"version":"1.0","callRendererFunction":{"surfaceId":"main","functionCallId":"c1",' +
          '"callFunction":{"@call":"openUrl","args":{"url":"https://example.test"},"catalogId":"https://example.test/catalog.json"}}}',
      ),
      msg('{"version":"1.0","agentFunctionResponse":{"functionCallId":"c1","value":true}}'),
    ]);
    const snapshot = session.snapshot();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.surfaces[0]!.versions).toEqual(['1.0']);
  });

  it('supports resync: reset and replay rebuilds identical state', () => {
    const messages = [
      msg(CREATE_MAIN),
      msg(
        '{"version":"1.0","updateComponents":{"surfaceId":"main","components":[' +
          '{"id":"root","component":"Text","text":"x"}]}}',
      ),
    ];
    const session = new A2UISession();
    session.applyAll(messages);
    const first = session.snapshot();
    session.reset();
    session.applyAll(messages);
    const second = session.snapshot();
    expect(JSON.stringify(second.surfaces)).toBe(JSON.stringify(first.surfaces));
    expect(second.issues).toEqual(first.issues);
  });

  it('is deterministic across independent runs (adaptA2UIMessages)', () => {
    const source = [
      '{"version":"1.0","createSurface":{"surfaceId":"s","components":[' +
        '{"id":"root","component":"Row","children":["a","b"]},' +
        '{"id":"a","component":"Text","text":{"@path":"/x"}},' +
        '{"id":"b","component":"Text","text":"ok"}]}}',
    ][0]!;
    const first = adaptA2UI(source);
    const second = adaptA2UI(source);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(adaptA2UIMessages(parseA2UISpec(source).messages).surfaces).toEqual(first.surfaces);
  });
});
