import type { JsonValue } from '@genui/ir';
import { canonicalize, isJsonValue } from '@genui/ir';
import { DEFAULT_SESSION_LIMITS } from './limits';
import type { SessionLimits } from './limits';

/**
 * 帧入队结果（v2 §5.2）。
 *
 * - queued / overflow：新帧已被接受入队（overflow 表示同时丢弃了最旧未处理帧）；
 * - dropped-invalid / dropped-oversized：整帧在入口隔离（fail-closed），不入队，
 *   不要求重同步——帧被拒绝这一事实对代理可见（1.8 指标），流本身可以继续。
 */
export type IngestStatus = 'queued' | 'dropped-invalid' | 'dropped-oversized' | 'overflow';

export interface IngestResult {
  readonly status: IngestStatus;
  /** 本帧的规范化 UTF-8 字节数（dropped-invalid 时为 0） */
  readonly frameBytes: number;
  /** 本次 ingest 之后的队列帧数快照 */
  readonly queueFrames: number;
  /** 本次 ingest 之后的队列累计字节快照 */
  readonly queueBytes: number;
  /** 本次 ingest 因溢出丢弃的最旧帧数（仅 overflow 时 > 0） */
  readonly dropped: number;
  /** 本次 ingest 是否触发了背压（丢弃了未处理帧，宿主必须全量重同步） */
  readonly resync: boolean;
}

/** 队列中的待处理帧。frameBytes 为入队时度量的规范化 UTF-8 字节数。 */
export interface QueuedFrame {
  readonly payload: JsonValue;
  readonly frameBytes: number;
}

const utf8 = new TextEncoder();

/**
 * 帧字节度量：canonical JSON（审计基准，v2 §5.3）的 UTF-8 字节数。
 * 确定性：同一 payload 字节数恒定，无隐藏状态。
 */
function measureFrameBytes(payload: JsonValue): number {
  return utf8.encode(canonicalize(payload)).length;
}

function validateLimits(limits: SessionLimits): void {
  const entries: Array<[string, number]> = [
    ['maxQueueFrames', limits.maxQueueFrames],
    ['maxQueueBytes', limits.maxQueueBytes],
    ['maxFrameBytes', limits.maxFrameBytes],
  ];
  for (const [name, value] of entries) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`session limit "${name}" must be a positive integer, got ${value}`);
    }
  }
  if (limits.maxFrameBytes > limits.maxQueueBytes) {
    throw new RangeError(
      `session limit "maxFrameBytes" (${limits.maxFrameBytes}) must not exceed "maxQueueBytes" (${limits.maxQueueBytes})`,
    );
  }
}

/**
 * 有界 pending 帧队列（v2 §5.2 背压核心）。
 *
 * - 入口兜底：isJsonValue（TD-004）——非 JSON 值（undefined/函数/Symbol/环/深度 >255/
 *   非 plain object）整帧隔离，永不过门；
 * - 单帧预算：canonical UTF-8 字节 > maxFrameBytes（TD-005，默认 256KB）整帧隔离；
 * - 背压：入队后帧数 > maxQueueFrames 或累计字节 > maxQueueBytes（先到者触发）时，
 *   自最旧端丢弃未处理帧直到回到限额内，并置 resync 标志——宿主必须请求 adapter
 *   全量重同步（A2UISession.reset() + createSurface 重放，v2 §5.2）。
 *
 * 不变量（构造校验保证）：任意操作后 frameCount ≤ maxQueueFrames 且
 * byteTotal ≤ maxQueueBytes。maxFrameBytes ≤ maxQueueBytes 使得单帧必然可容纳，
 * 新帧永远不会成为被丢弃的那一个。
 */
export class PendingFrameQueue {
  private readonly limits: SessionLimits;
  private readonly frames: QueuedFrame[] = [];
  private queuedBytes = 0;
  private resyncFlag = false;

  constructor(limits: Partial<SessionLimits> = {}) {
    const merged: SessionLimits = { ...DEFAULT_SESSION_LIMITS, ...limits };
    validateLimits(merged);
    this.limits = merged;
  }

  ingest(payload: unknown): IngestResult {
    if (!isJsonValue(payload)) {
      return {
        status: 'dropped-invalid',
        frameBytes: 0,
        queueFrames: this.frames.length,
        queueBytes: this.queuedBytes,
        dropped: 0,
        resync: false,
      };
    }
    const value = payload as JsonValue;
    const frameBytes = measureFrameBytes(value);
    if (frameBytes > this.limits.maxFrameBytes) {
      return {
        status: 'dropped-oversized',
        frameBytes,
        queueFrames: this.frames.length,
        queueBytes: this.queuedBytes,
        dropped: 0,
        resync: false,
      };
    }
    this.frames.push({ payload: value, frameBytes });
    this.queuedBytes += frameBytes;
    let dropped = 0;
    while (
      this.frames.length > this.limits.maxQueueFrames ||
      this.queuedBytes > this.limits.maxQueueBytes
    ) {
      const oldest = this.frames.shift()!;
      this.queuedBytes -= oldest.frameBytes;
      dropped += 1;
    }
    const resync = dropped > 0;
    if (resync) this.resyncFlag = true;
    return {
      status: resync ? 'overflow' : 'queued',
      frameBytes,
      queueFrames: this.frames.length,
      queueBytes: this.queuedBytes,
      dropped,
      resync,
    };
  }

  peekOldest(): QueuedFrame | null {
    return this.frames[0] ?? null;
  }

  takeOldest(): QueuedFrame | null {
    const frame = this.frames.shift();
    if (frame === undefined) return null;
    this.queuedBytes -= frame.frameBytes;
    return frame;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get byteTotal(): number {
    return this.queuedBytes;
  }

  /** 自上次消费以来是否发生过溢出（粘性标志） */
  get resyncRequired(): boolean {
    return this.resyncFlag;
  }

  /** 读取并清除 resync 标志 */
  consumeResync(): boolean {
    const value = this.resyncFlag;
    this.resyncFlag = false;
    return value;
  }

  /** 清空队列与 resync 标志（全量重同步路径：reset + replay 前调用） */
  clear(): void {
    this.frames.length = 0;
    this.queuedBytes = 0;
    this.resyncFlag = false;
  }
}
