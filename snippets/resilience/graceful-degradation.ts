/**
 * 优雅降级模式集合
 *
 * 模式：fail-open + 磁盘缓存回退 + 断路器
 * 关键点：
 * - 远程服务失败 → 磁盘缓存 → 跳过
 * - MCP/插件失败 → 不阻塞启动
 * - 压缩失败 → 断路器（3 次）
 * - 模型过载 → 回退到 fallback model
 */

// ========== Fail-Open 模式 ==========

async function withFailOpen<T>(
  operation: () => Promise<T>,
  fallback: {
    diskCache?: () => Promise<T | null>
    defaultValue: T
    logPrefix: string
    timeoutMs?: number
  },
): Promise<T> {
  try {
    const result = await withTimeout(
      operation(),
      fallback.timeoutMs ?? 10_000,
    )
    return result
  } catch (error) {
    console.warn(`${fallback.logPrefix}: ${error}`)

    // 尝试磁盘缓存
    if (fallback.diskCache) {
      const cached = await fallback.diskCache().catch(() => null)
      if (cached !== null) {
        console.info(`${fallback.logPrefix}: using disk cache`)
        return cached
      }
    }

    // 最终回退到默认值
    console.info(`${fallback.logPrefix}: using default value`)
    return fallback.defaultValue
  }
}

// 使用示例
const remoteSettings = await withFailOpen(
  () => fetchRemoteSettings(),
  {
    diskCache: () => readDiskCachedSettings(),
    defaultValue: {},
    logPrefix: 'Remote settings',
    timeoutMs: 10_000,
  },
)

const featureFlags = await withFailOpen(
  () => initializeFeatureFlags({ timeout: 5_000 }),
  {
    diskCache: () => readDiskCachedFlags(),
    defaultValue: new Map(),
    logPrefix: 'Feature flags',
    timeoutMs: 5_000,
  },
)

// ========== 断路器模式 ==========

interface CircuitBreaker {
  failures: number
  maxFailures: number
  isOpen: boolean
  lastFailureTime: number
  resetAfterMs: number
}

function createCircuitBreaker(config: {
  maxFailures: number
  resetAfterMs?: number
}): CircuitBreaker {
  return {
    failures: 0,
    maxFailures: config.maxFailures,
    isOpen: false,
    lastFailureTime: 0,
    resetAfterMs: config.resetAfterMs ?? Infinity,
  }
}

function recordFailure(breaker: CircuitBreaker): CircuitBreaker {
  const failures = breaker.failures + 1
  return {
    ...breaker,
    failures,
    isOpen: failures >= breaker.maxFailures,
    lastFailureTime: Date.now(),
  }
}

function recordSuccess(breaker: CircuitBreaker): CircuitBreaker {
  return { ...breaker, failures: 0, isOpen: false }
}

function canAttempt(breaker: CircuitBreaker): boolean {
  if (!breaker.isOpen) return true
  // 自动恢复（超过重置时间后）
  if (Date.now() - breaker.lastFailureTime > breaker.resetAfterMs) {
    return true  // 半开状态，尝试一次
  }
  return false
}

// 使用示例
const compactBreaker = createCircuitBreaker({ maxFailures: 3 })

async function maybeCompact(messages: Message[]): Promise<boolean> {
  if (!canAttempt(compactBreaker)) {
    console.warn('Compact circuit breaker open, skipping')
    return false
  }

  try {
    await compactMessages(messages)
    compactBreaker = recordSuccess(compactBreaker)
    return true
  } catch {
    compactBreaker = recordFailure(compactBreaker)
    return false
  }
}

// ========== 非致命初始化 ==========

async function initializeNonCritical(
  initializers: Array<{
    name: string
    init: () => Promise<void>
    timeoutMs?: number
  }>,
): Promise<void> {
  await Promise.allSettled(
    initializers.map(async ({ name, init, timeoutMs }) => {
      try {
        await withTimeout(init(), timeoutMs ?? 5_000)
      } catch (err) {
        console.warn(`Non-critical init failed [${name}]: ${err}`)
        // 不阻塞启动
      }
    }),
  )
}

// 使用示例
await initializeNonCritical([
  { name: 'MCP servers', init: () => connectMcpServers() },
  { name: 'Plugins', init: () => loadPlugins(), timeoutMs: 10_000 },
  { name: 'LSP servers', init: () => connectLspServers() },
  { name: 'Analytics', init: () => initializeAnalytics() },
])
