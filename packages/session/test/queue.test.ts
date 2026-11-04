import { canonicalize, isJsonValue } from '@genui/ir';
import type { JsonValue } from '@genui/ir';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_LIMITS } from '../src/limits';
import { PendingFrameQueue } from '../src/queue';
import type { IngestResult } from '../src/queue';

const utf8 = new TextEncoder();

function byteSize(payload: JsonValue): number {
  return utf8.encode(canonicalize(payload)).length;
}

/** 包 depth 层嵌套数组的值：depth ≤ 256 时是合法 JSON 值，≥ 257 时深度超限 */
function nestedArrays(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

const cyclicObject = (): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
};

describe('DEFAULT_SESSION_LIMITS (v2 §5.2/§6.6)', () => {
  it('matches the spec: 100 frames / 4MB queue / 256KB frame', () => {
    expect(DEFAULT_SESSION_LIMITS).toEqual({
      maxQueueFrames: 100,
      maxQueueBytes: 4 * 1024 * 1024,
      maxFrameBytes: 256 * 1024,
    });
  });
});

describe('constructor validation', () => {
  it('accepts partial overrides and equal frame/queue byte limits', () => {
    expect(() => new PendingFrameQueue()).not.toThrow();
    expect(() => new PendingFrameQueue({ maxQueueFrames: 1 })).not.toThrow();
    expect(() => new PendingFrameQueue({ maxFrameBytes: 256, maxQueueBytes: 256 })).not.toThrow();
  });

  it('rejects non-positive, fractional, NaN limits and frame > queue bytes', () => {
    expect(() => new PendingFrameQueue({ maxQueueFrames: 0 })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxQueueFrames: -1 })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxQueueFrames: 1.5 })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxQueueFrames: Number.NaN })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxQueueBytes: 0 })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxFrameBytes: 0 })).toThrow(RangeError);
    expect(() => new PendingFrameQueue({ maxFrameBytes: 300, maxQueueBytes: 256 })).toThrow(RangeError);
  });
});

describe('PendingFrameQueue.ingest', () => {
  it('queues a valid frame with canonical UTF-8 byte accounting', () => {
    const queue = new PendingFrameQueue();
    const result = queue.ingest({ label: '中文' });
    expect(result).toEqual({
      status: 'queued',
      frameBytes: 18,
      queueFrames: 1,
      queueBytes: 18,
      dropped: 0,
      resync: false,
    });
    expect(queue.frameCount).toBe(1);
    expect(queue.byteTotal).toBe(18);
    expect(queue.resyncRequired).toBe(false);
  });

  it('enforces FIFO order across takeOldest/peekOldest', () => {
    const queue = new PendingFrameQueue();
    queue.ingest({ i: 1 });
    queue.ingest({ i: 2 });
    queue.ingest({ i: 3 });
    expect(queue.peekOldest()?.payload).toEqual({ i: 1 });
    expect(queue.takeOldest()?.payload).toEqual({ i: 1 });
    expect(queue.takeOldest()?.payload).toEqual({ i: 2 });
    expect(queue.takeOldest()?.payload).toEqual({ i: 3 });
    expect(queue.takeOldest()).toBeNull();
    expect(queue.peekOldest()).toBeNull();
    expect(queue.byteTotal).toBe(0);
  });

  it('drops non-JSON payloads at the door (TD-004) without touching the queue', () => {
    const queue = new PendingFrameQueue();
    queue.ingest({ keep: true });
    const invalid: unknown[] = [
      undefined,
      () => {},
      Symbol('x'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      { a: undefined },
      [null, undefined],
      cyclicObject(),
      nestedArrays(257),
    ];
    for (const payload of invalid) {
      const result = queue.ingest(payload);
      expect(result.status).toBe('dropped-invalid');
      expect(result.frameBytes).toBe(0);
      expect(result.dropped).toBe(0);
      expect(result.resync).toBe(false);
    }
    expect(queue.frameCount).toBe(1);
    expect(queue.byteTotal).toBe(byteSize({ keep: true }));
    expect(queue.resyncRequired).toBe(false);
  });

  it('accepts depth-256 nested arrays and shared (DAG) references', () => {
    const queue = new PendingFrameQueue();
    expect(queue.ingest(nestedArrays(256)).status).toBe('queued');
    const shared = { v: 1 };
    expect(queue.ingest({ x: shared, y: shared }).status).toBe('queued');
    expect(queue.frameCount).toBe(2);
  });

  it('enforces the 256KB single-frame budget (TD-005) at the exact boundary', () => {
    const queue = new PendingFrameQueue();
    const atLimit = { a: 'x'.repeat(262136) };
    const overLimit = { a: 'x'.repeat(262137) };
    expect(byteSize(atLimit)).toBe(262144);
    expect(queue.ingest(atLimit).status).toBe('queued');
    expect(queue.frameCount).toBe(1);
    const result = queue.ingest(overLimit);
    expect(result).toMatchObject({ status: 'dropped-oversized', frameBytes: 262145, dropped: 0, resync: false });
    expect(queue.frameCount).toBe(1);
    expect(queue.byteTotal).toBe(262144);
    expect(queue.resyncRequired).toBe(false);
  });
});

describe('PendingFrameQueue backpressure (v2 §5.2)', () => {
  it('drops the oldest unprocessed frame on frame-count overflow and flags resync', () => {
    const queue = new PendingFrameQueue({ maxQueueFrames: 3, maxQueueBytes: 10000, maxFrameBytes: 10000 });
    queue.ingest({ i: 1 });
    queue.ingest({ i: 2 });
    queue.ingest({ i: 3 });
    const result = queue.ingest({ i: 4 });
    expect(result).toMatchObject({ status: 'overflow', dropped: 1, resync: true, queueFrames: 3 });
    expect(queue.resyncRequired).toBe(true);
    expect(queue.takeOldest()?.payload).toEqual({ i: 2 });
    expect(queue.consumeResync()).toBe(true);
    expect(queue.consumeResync()).toBe(false);
    expect(queue.resyncRequired).toBe(false);
  });

  it('triggers on cumulative bytes before the frame count (first-limit-wins)', () => {
    const queue = new PendingFrameQueue({ maxQueueFrames: 100, maxQueueBytes: 24, maxFrameBytes: 20 });
    queue.ingest({ a: 12345678901 });
    const result = queue.ingest({ b: 12345678901 });
    expect(result).toMatchObject({ status: 'overflow', dropped: 1, resync: true });
    expect(queue.frameCount).toBe(1);
    expect(queue.takeOldest()?.payload).toEqual({ b: 12345678901 });
  });

  it('can drop multiple oldest frames in a single ingest', () => {
    const queue = new PendingFrameQueue({ maxQueueFrames: 50, maxQueueBytes: 100, maxFrameBytes: 100 });
    for (let i = 0; i < 10; i++) {
      queue.ingest({ a: 1234 });
    }
    expect(queue.frameCount).toBe(10);
    expect(queue.byteTotal).toBe(100);
    const big = { a: 'y'.repeat(92) };
    const result = queue.ingest(big);
    expect(result).toMatchObject({ status: 'overflow', dropped: 10, queueFrames: 1, queueBytes: 100, resync: true });
    expect(queue.takeOldest()?.payload).toEqual(big);
  });

  it('clear() empties the queue and the resync flag', () => {
    const queue = new PendingFrameQueue({ maxQueueFrames: 1, maxQueueBytes: 10000, maxFrameBytes: 10000 });
    queue.ingest({ i: 1 });
    queue.ingest({ i: 2 });
    expect(queue.resyncRequired).toBe(true);
    queue.clear();
    expect(queue.frameCount).toBe(0);
    expect(queue.byteTotal).toBe(0);
    expect(queue.resyncRequired).toBe(false);
    expect(queue.takeOldest()).toBeNull();
  });
});

interface ModelFrame {
  canonical: string;
  bytes: number;
}

/** 规格直译模型：与实现结构不同（每次求和、无增量字节），交叉验证队列策略 */
class Model {
  readonly frames: ModelFrame[] = [];
  resync = false;

  constructor(
    private readonly limits: { maxQueueFrames: number; maxQueueBytes: number; maxFrameBytes: number },
  ) {}

  totalBytes(): number {
    return this.frames.reduce((sum, frame) => sum + frame.bytes, 0);
  }

  ingest(payload: unknown): IngestResult {
    if (!isJsonValue(payload)) {
      return { status: 'dropped-invalid', frameBytes: 0, queueFrames: this.frames.length, queueBytes: this.totalBytes(), dropped: 0, resync: false };
    }
    const canonical = canonicalize(payload as JsonValue);
    const bytes = utf8.encode(canonical).length;
    if (bytes > this.limits.maxFrameBytes) {
      return { status: 'dropped-oversized', frameBytes: bytes, queueFrames: this.frames.length, queueBytes: this.totalBytes(), dropped: 0, resync: false };
    }
    this.frames.push({ canonical, bytes });
    let dropped = 0;
    while (this.frames.length > this.limits.maxQueueFrames || this.totalBytes() > this.limits.maxQueueBytes) {
      this.frames.shift();
      dropped += 1;
    }
    if (dropped > 0) this.resync = true;
    return {
      status: dropped > 0 ? 'overflow' : 'queued',
      frameBytes: bytes,
      queueFrames: this.frames.length,
      queueBytes: this.totalBytes(),
      dropped,
      resync: dropped > 0,
    };
  }

  take(): ModelFrame | null {
    return this.frames.shift() ?? null;
  }
}

type Op =
  | { kind: 'ingest'; payload: unknown }
  | { kind: 'take' }
  | { kind: 'peek' }
  | { kind: 'consumeResync' }
  | { kind: 'clear' };

const invalidPayloadArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY, () => {}, new Date(), new Map()),
  fc.constant(undefined).map(() => ({ x: undefined })),
  fc.constant(undefined).map(() => cyclicObject()),
  fc.integer({ min: 257, max: 400 }).map((depth) => nestedArrays(depth)),
);

const validPayloadArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.json(),
  fc.integer({ min: 0, max: 256 }).map((depth) => nestedArrays(depth)),
  fc.json().map((base) => {
    const shared = { s: 1 };
    return { x: shared, y: shared, base };
  }),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: validPayloadArb.map((payload): Op => ({ kind: 'ingest', payload })) },
  { weight: 3, arbitrary: invalidPayloadArb.map((payload): Op => ({ kind: 'ingest', payload })) },
  { weight: 4, arbitrary: fc.constant<Op>({ kind: 'take' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'peek' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'consumeResync' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'clear' }) },
);

describe('PendingFrameQueue property tests', () => {
  it('matches the spec model over random op sequences (200 runs)', () => {
    const limits = { maxQueueFrames: 5, maxQueueBytes: 200, maxFrameBytes: 100 };
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const queue = new PendingFrameQueue(limits);
        const model = new Model(limits);
        for (const op of ops) {
          if (op.kind === 'ingest') {
            expect(queue.ingest(op.payload)).toEqual(model.ingest(op.payload));
          } else if (op.kind === 'take') {
            const frame = queue.takeOldest();
            const expected = model.take();
            if (expected === null) {
              expect(frame).toBeNull();
            } else {
              expect(frame).not.toBeNull();
              expect(canonicalize(frame!.payload)).toBe(expected.canonical);
              expect(frame!.frameBytes).toBe(expected.bytes);
            }
          } else if (op.kind === 'peek') {
            const frame = queue.peekOldest();
            const expected = model.frames[0] ?? null;
            if (expected === null) {
              expect(frame).toBeNull();
            } else {
              expect(frame).not.toBeNull();
              expect(canonicalize(frame!.payload)).toBe(expected.canonical);
            }
          } else if (op.kind === 'consumeResync') {
            expect(queue.consumeResync()).toBe(model.resync);
            model.resync = false;
          } else {
            queue.clear();
            model.frames.length = 0;
            model.resync = false;
          }
          expect(queue.frameCount).toBe(model.frames.length);
          expect(queue.byteTotal).toBe(model.totalBytes());
          expect(queue.resyncRequired).toBe(model.resync);
          expect(queue.frameCount).toBeLessThanOrEqual(limits.maxQueueFrames);
          expect(queue.byteTotal).toBeLessThanOrEqual(limits.maxQueueBytes);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('rejections never mutate queue state (300 runs)', () => {
    fc.assert(
      fc.property(validPayloadArb, invalidPayloadArb, (valid, invalid) => {
        const queue = new PendingFrameQueue({ maxQueueFrames: 4, maxQueueBytes: 400, maxFrameBytes: 200 });
        queue.ingest({ seed: true });
        queue.ingest(valid);
        const before = { count: queue.frameCount, bytes: queue.byteTotal, resync: queue.resyncRequired };
        const result = queue.ingest(invalid);
        expect(result.status).toBe('dropped-invalid');
        expect(queue.frameCount).toBe(before.count);
        expect(queue.byteTotal).toBe(before.bytes);
        expect(queue.resyncRequired).toBe(before.resync);
        expect(result.dropped).toBe(0);
        expect(result.resync).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('frame byte size is deterministic across fresh queues (200 runs)', () => {
    fc.assert(
      fc.property(validPayloadArb, (payload) => {
        const first = new PendingFrameQueue();
        const second = new PendingFrameQueue();
        const firstResult = first.ingest(payload);
        const secondResult = second.ingest(payload);
        expect(secondResult.frameBytes).toBe(firstResult.frameBytes);
        expect(second.byteTotal).toBe(first.byteTotal);
      }),
      { numRuns: 200 },
    );
  });
});
