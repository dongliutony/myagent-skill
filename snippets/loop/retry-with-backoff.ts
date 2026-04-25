/**
 * 指数退避重试 + 抖动 + 模型回退
 *
 * 模式：for 循环重试 + 错误分类 + 退避策略
 * 关键点：
 * - 指数退避公式：BASE * 2^(attempt-1)，上限 32s，±25% 抖动
 * - 不同错误类型有不同处理策略
 * - 连续过载 3 次触发模型回退
 * - 尊重 Retry-After 响应头
 * - 持久模式支持无限重试（无人值守场景）
 */

const DEFAULT_MAX_RETRIES = 10
const MAX_OVERLOAD_RETRIES = 3     // 连续过载后触发回退
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 32_000
const JITTER_FACTOR = 0.25          // ±25%

interface RetryOptions {
  maxRetries?: number
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
  signal?: AbortSignal
  persistentMode?: boolean          // 无人值守无限重试
  persistentMaxHours?: number       // 持久模式上限（默认 6h）
}

class FallbackTriggeredError extends Error {
  constructor(public readonly consecutiveOverloads: number) {
    super(`Fallback triggered after ${consecutiveOverloads} consecutive overloads`)
  }
}

async function* withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): AsyncGenerator<RetryEvent, T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  let consecutiveOverloads = 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation(attempt)
      return result
    } catch (error) {
      if (options.signal?.aborted) throw error

      const classification = classifyError(error)

      switch (classification.type) {
        case 'overloaded': // 529
          consecutiveOverloads++
          if (consecutiveOverloads >= MAX_OVERLOAD_RETRIES) {
            throw new FallbackTriggeredError(consecutiveOverloads)
          }
          break

        case 'rate_limited': // 429
          consecutiveOverloads = 0  // 重置过载计数
          break

        case 'auth_expired': // 401
          await refreshAuthToken()
          consecutiveOverloads = 0
          continue  // 立即重试，不退避

        case 'auth_revoked': // 403
          await refreshOAuthToken()
          consecutiveOverloads = 0
          continue

        case 'connection_reset': // ECONNRESET/EPIPE
          disableKeepAlive()
          consecutiveOverloads = 0
          break

        case 'non_retryable':
          throw error  // 不重试
      }

      if (attempt > maxRetries) {
        if (options.persistentMode) {
          // 持久模式：无限重试 + 心跳
          yield* persistentRetry(operation, options)
          return // unreachable, persistentRetry returns or throws
        }
        throw error
      }

      // 计算退避延迟
      const delay = calculateDelay(attempt, classification.retryAfterMs)
      yield { type: 'retrying', attempt, delay, error: classification }
      options.onRetry?.(attempt, error as Error, delay)

      await sleep(delay, options.signal)
    }
  }

  throw new Error('Retry loop exhausted')  // 不应到达
}

// ========== 退避计算 ==========

function calculateDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs  // 尊重 Retry-After

  const exponential = BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, MAX_DELAY_MS)
  const jitter = capped * (1 + JITTER_FACTOR * (2 * Math.random() - 1))
  return Math.round(jitter)
}

// ========== 错误分类 ==========

interface ErrorClassification {
  type: 'overloaded' | 'rate_limited' | 'auth_expired' | 'auth_revoked'
       | 'connection_reset' | 'context_overflow' | 'non_retryable'
  retryAfterMs?: number
}

function classifyError(error: unknown): ErrorClassification {
  if (isHttpError(error)) {
    switch (error.status) {
      case 529: return { type: 'overloaded' }
      case 429: return {
        type: 'rate_limited',
        retryAfterMs: parseRetryAfter(error.headers),
      }
      case 401: return { type: 'auth_expired' }
      case 403: return { type: 'auth_revoked' }
      case 413: return { type: 'context_overflow' }
      default:
        if (error.status >= 500) return { type: 'overloaded' }
        return { type: 'non_retryable' }
    }
  }
  if (isConnectionError(error)) return { type: 'connection_reset' }
  return { type: 'non_retryable' }
}

// ========== 持久模式 ==========

const HEARTBEAT_INTERVAL_MS = 30_000
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000  // 5 分钟
const PERSISTENT_MAX_TOTAL_MS = 6 * 60 * 60 * 1000  // 6 小时

async function* persistentRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<RetryEvent, T> {
  const startTime = Date.now()
  const maxTotalMs = (options.persistentMaxHours ?? 6) * 3600 * 1000
  let attempt = 0

  while (Date.now() - startTime < maxTotalMs) {
    attempt++
    try {
      return await operation(attempt)
    } catch {
      const delay = Math.min(
        BASE_DELAY_MS * Math.pow(2, Math.min(attempt, 10)),
        PERSISTENT_MAX_BACKOFF_MS,
      )
      // 分段 sleep，每 30 秒发心跳
      let remaining = delay
      while (remaining > 0) {
        const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
        await sleep(chunk, options.signal)
        remaining -= chunk
        yield { type: 'heartbeat', elapsed: Date.now() - startTime }
      }
    }
  }
  throw new Error(`Persistent retry exhausted after ${maxTotalMs}ms`)
}
