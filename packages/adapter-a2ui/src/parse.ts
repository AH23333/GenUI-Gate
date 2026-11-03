import type { A2UIMessage, A2UIMessageKind, AdapterIssue } from './types';

const MESSAGE_KEYS: readonly A2UIMessageKind[] = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
];

interface ExtractOutcome {
  message?: A2UIMessage;
  issue?: AdapterIssue;
}

export function extractMessage(value: unknown, index: number): ExtractOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issue: { code: 'parse-error', message: 'stream entry is not a JSON object', messageIndex: index } };
  }
  const envelope = value as Record<string, unknown>;
  const present: A2UIMessageKind[] = [];
  for (const key of MESSAGE_KEYS) {
    if (key in envelope) present.push(key);
  }
  if (present.length === 0) {
    return {
      issue: {
        code: 'unknown-message-kind',
        message: 'envelope carries none of the A2UI message keys',
        messageIndex: index,
      },
    };
  }
  if (present.length > 1) {
    return {
      issue: {
        code: 'duplicate-message-key',
        message: `envelope carries multiple message keys: ${present.join(', ')}`,
        messageIndex: index,
      },
    };
  }
  const kind = present[0]!;
  const payload = envelope[kind];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      issue: {
        code: 'invalid-message-payload',
        message: `"${kind}" payload is not a JSON object`,
        messageIndex: index,
      },
    };
  }
  const allowed = new Set<string>(['version', kind]);
  for (const key of Object.keys(envelope)) {
    if (!allowed.has(key)) {
      return {
        issue: {
          code: 'unexpected-envelope-key',
          message: `envelope carries unexpected key "${key}"`,
          messageIndex: index,
        },
      };
    }
  }
  const version = envelope['version'];
  return {
    message: {
      kind,
      payload: payload as Record<string, unknown>,
      ...(typeof version === 'string' ? { version } : {}),
    },
  };
}

function extractAll(values: unknown[], issues: AdapterIssue[]): A2UIMessage[] {
  const messages: A2UIMessage[] = [];
  for (let i = 0; i < values.length; i++) {
    const outcome = extractMessage(values[i], i);
    if (outcome.message) messages.push({ ...outcome.message, messageIndex: i });
    if (outcome.issue) issues.push({ ...outcome.issue, messageIndex: i });
  }
  return messages;
}

export interface ParsedSpec {
  messages: A2UIMessage[];
  issues: AdapterIssue[];
}

/**
 * Accepts, in order of detection:
 * - the official example wrapper `{ name, description, messages: [...] }`
 * - a bare JSON array of envelope messages
 * - a single envelope message object
 * - JSONL text (one envelope message per line)
 */
export function parseA2UISpec(input: string): ParsedSpec {
  const issues: AdapterIssue[] = [];
  const trimmed = input.trim();
  if (trimmed === '') {
    return { messages: [], issues: [{ code: 'parse-error', message: 'input is empty' }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return parseJsonl(trimmed);
  }
  if (Array.isArray(parsed)) {
    return { messages: extractAll(parsed, issues), issues };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const candidate = parsed as Record<string, unknown>;
    if (Array.isArray(candidate['messages'])) {
      return { messages: extractAll(candidate['messages'], issues), issues };
    }
    const single = extractMessage(parsed, 0);
    if (single.message) return { messages: [{ ...single.message, messageIndex: 0 }], issues };
    return { messages: [], issues: single.issue ? [single.issue] : [] };
  }
  return {
    messages: [],
    issues: [{ code: 'parse-error', message: 'top-level JSON value is not an object or array' }],
  };
}

function parseJsonl(text: string): ParsedSpec {
  const issues: AdapterIssue[] = [];
  const messages: A2UIMessage[] = [];
  const lines = text.split(/\r?\n/);
  let index = 0;
  for (const line of lines) {
    const content = line.trim();
    if (content === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      issues.push({ code: 'parse-error', message: 'line is not valid JSON', messageIndex: index });
      index += 1;
      continue;
    }
    const outcome = extractMessage(value, index);
    if (outcome.message) messages.push({ ...outcome.message, messageIndex: index });
    if (outcome.issue) issues.push(outcome.issue);
    index += 1;
  }
  return { messages, issues };
}
