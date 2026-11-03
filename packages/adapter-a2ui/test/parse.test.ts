import { describe, expect, it } from 'vitest';
import { extractMessage, parseA2UISpec } from '../src/parse';

const CREATE = '{"version":"1.0","createSurface":{"surfaceId":"s1","catalogId":"https://example.test/catalog.json"}}';
const UPDATE = '{"version":"1.0","updateComponents":{"surfaceId":"s1","components":[{"id":"root","component":"Text","text":"hi"}]}}';
const DATA = '{"version":"1.0","updateDataModel":{"surfaceId":"s1","path":"/a","value":1}}';
const DELETE = '{"version":"1.0","deleteSurface":{"surfaceId":"s1"}}';

describe('extractMessage', () => {
  it('extracts each of the six message kinds', () => {
    const kinds = [
      'createSurface',
      'updateComponents',
      'updateDataModel',
      'deleteSurface',
      'callRendererFunction',
      'agentFunctionResponse',
    ];
    for (const kind of kinds) {
      const outcome = extractMessage({ version: '1.0', [kind]: { any: true } }, 0);
      expect(outcome.message?.kind).toBe(kind);
      expect(outcome.issue).toBeUndefined();
    }
  });

  it('keeps the version when present and omits it otherwise', () => {
    expect(extractMessage(JSON.parse(CREATE), 0).message?.version).toBe('1.0');
    expect(extractMessage({ createSurface: { surfaceId: 's' } }, 0).message?.version).toBeUndefined();
  });

  it('flags non-object entries', () => {
    expect(extractMessage('nope', 3).issue?.code).toBe('parse-error');
    expect(extractMessage([1], 3).issue?.code).toBe('parse-error');
  });

  it('flags envelopes without a message key', () => {
    expect(extractMessage({ version: '1.0' }, 0).issue?.code).toBe('unknown-message-kind');
  });

  it('flags envelopes with several message keys', () => {
    const outcome = extractMessage({ createSurface: {}, deleteSurface: {} }, 0);
    expect(outcome.issue?.code).toBe('duplicate-message-key');
  });

  it('flags non-object payloads', () => {
    const outcome = extractMessage({ createSurface: 'nope' }, 0);
    expect(outcome.issue?.code).toBe('invalid-message-payload');
  });

  it('flags unexpected envelope keys', () => {
    const outcome = extractMessage({ version: '1.0', createSurface: {}, extra: 1 }, 0);
    expect(outcome.issue?.code).toBe('unexpected-envelope-key');
  });
});

describe('parseA2UISpec', () => {
  it('parses a JSONL stream', () => {
    const parsed = parseA2UISpec([CREATE, UPDATE, DATA, DELETE].join('\n'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.messages.map((m) => m.kind)).toEqual([
      'createSurface',
      'updateComponents',
      'updateDataModel',
      'deleteSurface',
    ]);
    expect(parsed.messages.map((m) => m.messageIndex)).toEqual([0, 1, 2, 3]);
  });

  it('tolerates blank lines and CRLF in JSONL', () => {
    const parsed = parseA2UISpec(`\r\n${CREATE}\r\n\r\n${DELETE}\r\n`);
    expect(parsed.messages.length).toBe(2);
    expect(parsed.issues).toEqual([]);
  });

  it('collects issues per bad line without dropping good ones', () => {
    const parsed = parseA2UISpec([CREATE, '{broken', UPDATE].join('\n'));
    expect(parsed.messages.length).toBe(2);
    expect(parsed.issues.length).toBe(1);
    expect(parsed.issues[0]).toMatchObject({ code: 'parse-error', messageIndex: 1 });
  });

  it('parses a bare JSON array of messages', () => {
    const parsed = parseA2UISpec(`[${CREATE},${DELETE}]`);
    expect(parsed.messages.map((m) => m.kind)).toEqual(['createSurface', 'deleteSurface']);
    expect(parsed.messages[1]!.messageIndex).toBe(1);
  });

  it('parses the official example wrapper', () => {
    const input = `{"name":"Demo","description":"d","messages":[${CREATE},${UPDATE}]}`;
    const parsed = parseA2UISpec(input);
    expect(parsed.issues).toEqual([]);
    expect(parsed.messages.length).toBe(2);
  });

  it('parses a single message object', () => {
    const parsed = parseA2UISpec(CREATE);
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0]!.kind).toBe('createSurface');
    expect(parsed.messages[0]!.messageIndex).toBe(0);
  });

  it('reports issues on invalid entries inside arrays and wrappers', () => {
    const arrayParsed = parseA2UISpec('[{"version":"1.0"},' + CREATE + ']');
    expect(arrayParsed.messages.length).toBe(1);
    expect(arrayParsed.issues[0]).toMatchObject({ code: 'unknown-message-kind', messageIndex: 0 });

    const wrapperParsed = parseA2UISpec(`{"messages":[${CREATE},"nope"]}`);
    expect(wrapperParsed.messages.length).toBe(1);
    expect(wrapperParsed.issues[0]).toMatchObject({ code: 'parse-error', messageIndex: 1 });
  });

  it('rejects empty input and non-container top-level JSON', () => {
    expect(parseA2UISpec('   ').issues[0]?.code).toBe('parse-error');
    expect(parseA2UISpec('42').issues[0]?.code).toBe('parse-error');
  });
});
