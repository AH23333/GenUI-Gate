/**
 * Session 级硬上限（v2 §5.2 / §6.6）。
 *
 * 默认值即 v2 §6.6 规格：pending 帧队列 ≤ 100 帧且累计 ≤ 4MB（先到者触发溢出），
 * 单帧 ≤ 256KB。宿主可通过 Partial 覆盖（只能收紧才是符合规格的用法；
 * 放宽即离开规格保证，责任在宿主，见 KAN-024）。
 */
export interface SessionLimits {
  /** pending 队列最大帧数（默认 100） */
  readonly maxQueueFrames: number;
  /** pending 队列最大累计字节（默认 4MB） */
  readonly maxQueueBytes: number;
  /** 单帧最大字节（默认 256KB） */
  readonly maxFrameBytes: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxQueueFrames: 100,
  maxQueueBytes: 4 * 1024 * 1024,
  maxFrameBytes: 256 * 1024,
});
