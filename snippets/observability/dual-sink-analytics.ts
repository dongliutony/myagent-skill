/**
 * 双写分析管线 + OTEL 集成 + 事件采样
 *
 * 模式：事件队列缓冲 → 初始化后刷新 → 双写（第一方 + 外部）
 * 关键点：
 * - 初始化前缓冲事件（不丢失启动阶段数据）
 * - 数据安全标记强制
 * - 用户隐私：SHA256 哈希分桶
 * - 动态采样率配置
 */

// ========== 安全标记（强制） ==========

// 这些 branded type 防止误传敏感数据
type SafeMetadata = { __brand: 'VERIFIED_NOT_CODE_OR_FILEPATHS' }
type PIITaggedMetadata = { __brand: 'VERIFIED_PII_TAGGED' }

// ========== 事件队列（初始化前缓冲） ==========

let analyticsInitialized = false
const eventQueue: AnalyticsEvent[] = []
const sinks: AnalyticsSink[] = []

function logEvent(
  name: string,
  metadata: Record<string, unknown> & (SafeMetadata | PIITaggedMetadata),
): void {
  const event: AnalyticsEvent = {
    name,
    metadata,
    timestamp: Date.now(),
    sessionId: getSessionId(),
  }

  if (!analyticsInitialized) {
    eventQueue.push(event)
    return
  }

  for (const sink of sinks) {
    sink.send(event)
  }
}

function initializeAnalytics(config: AnalyticsConfig): void {
  sinks.push(new FirstPartySink(config.firstPartyEndpoint))
  sinks.push(new DatadogSink(config.datadogEndpoint))
  analyticsInitialized = true

  // 刷新缓冲的事件
  for (const event of eventQueue) {
    for (const sink of sinks) {
      sink.send(event)
    }
  }
  eventQueue.length = 0
}

// ========== Datadog Sink（批量 + 隐私控制） ==========

class DatadogSink implements AnalyticsSink {
  private batch: AnalyticsEvent[] = []
  private flushInterval = 15_000  // 15 秒
  private maxBatchSize = 100
  private allowedEvents: Set<string>

  constructor(private endpoint: string) {
    this.allowedEvents = new Set(ALLOWED_EVENT_NAMES)
    setInterval(() => this.flush(), this.flushInterval)
  }

  send(event: AnalyticsEvent): void {
    if (!this.allowedEvents.has(event.name)) return  // 白名单过滤

    // 隐私：用户 ID → SHA256 哈希分 30 桶
    event.metadata.userBucket = hashToBucket(event.metadata.userId, 30)
    delete event.metadata.userId

    // 基数缩减
    event.metadata.model = normalizeModelName(event.metadata.model)
    event.metadata.version = truncateVersion(event.metadata.version)

    this.batch.push(event)
    if (this.batch.length >= this.maxBatchSize) this.flush()
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return
    const events = this.batch.splice(0)
    await fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(events),
    }).catch(() => {})  // 静默失败
  }
}

function hashToBucket(value: string, buckets: number): number {
  const hash = crypto.createHash('sha256').update(value).digest()
  return hash.readUInt32BE(0) % buckets
}

// ========== 动态事件采样 ==========

interface SamplingConfig {
  [eventName: string]: number  // 0-1 采样率
}

let samplingConfig: SamplingConfig = {}

function shouldSampleEvent(eventName: string): boolean {
  const rate = samplingConfig[eventName]
  if (rate === undefined) return true  // 未配置 = 100%
  return Math.random() < rate
}

// 从 Feature Flag 服务加载采样配置
function loadSamplingConfig(config: SamplingConfig): void {
  samplingConfig = config
}

// ========== OTEL 会话追踪 ==========

function startInteractionSpan(
  tracer: Tracer,
  operationName: string,
): Span {
  return tracer.startSpan(operationName, {
    attributes: {
      'session.id': getSessionId(),
      'user.id': getUserId(),  // hashed
    },
  })
}

function endInteractionSpan(
  span: Span,
  result: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    duration: number
    error?: Error
  },
): void {
  span.setAttributes({
    'llm.input_tokens': result.inputTokens,
    'llm.output_tokens': result.outputTokens,
    'llm.cache_read_tokens': result.cacheReadTokens,
    'llm.duration_ms': result.duration,
  })

  if (result.error) {
    span.recordException(result.error)
    span.setStatus({ code: SpanStatusCode.ERROR })
  }

  span.end()
}

// ========== 指标定义 ==========

function createMetrics(meter: Meter) {
  return {
    sessionCounter: meter.createCounter('agent.sessions'),
    costCounter: meter.createCounter('agent.cost_usd'),
    tokenCounter: meter.createCounter('agent.tokens', {
      description: 'Token usage by type',
    }),
    toolDurationHistogram: meter.createHistogram('agent.tool_duration_ms'),
    apiDurationHistogram: meter.createHistogram('agent.api_duration_ms'),
    locCounter: meter.createCounter('agent.lines_changed'),
  }
}
