/**
 * 全链路 AsyncGenerator 流式架构
 *
 * 模式：嵌套 Generator 委托 + 消息扣留 + 空闲看门狗
 * 关键点：
 * - yield* 委托实现 Generator 组合
 * - 可恢复错误扣留不 yield，不可恢复才 yield
 * - 90s 空闲看门狗 → 非流式回退
 * - 进度与完成解耦（Promise.race）
 */

// ========== Generator 组合模式 ==========

// 层 1：API 流式调用
async function* queryModelStreaming(
  params: APIParams,
): AsyncGenerator<StreamEvent> {
  const stream = await createSSEStream(params)
  try {
    for await (const event of stream) {
      yield event
    }
  } finally {
    stream.close()
  }
}

// 层 2：重试包装
async function* queryWithRetry(
  params: APIParams,
): AsyncGenerator<StreamEvent | RetryEvent, APIResult> {
  return yield* withRetry(
    async () => {
      const events: StreamEvent[] = []
      for await (const event of queryModelStreaming(params)) {
        events.push(event)
      }
      return assembleResult(events)
    },
    { maxRetries: 10 },
  )
}

// 层 3：工具执行 + 循环
async function* queryLoop(
  params: QueryParams,
): AsyncGenerator<LoopEvent, Terminal> {
  while (true) {
    // 调用 API（委托到层 2）
    const result = yield* queryWithRetry(params)

    // 执行工具（委托到执行器）
    if (result.stopReason === 'tool_use') {
      yield* executeToolsStreaming(result.toolUseBlocks, params)
    }

    // ... 终止/继续判断
  }
}

// 层 4：SDK 封装
async function* submitMessage(
  prompt: string,
): AsyncGenerator<SDKMessage> {
  for await (const event of queryLoop(buildParams(prompt))) {
    yield transformToSDKMessage(event)
  }
}

// ========== 消息扣留机制 ==========

interface WithholdState {
  withheldMessages: Message[]     // 扣留的消息
  assistantMessages: Message[]    // 始终推送（用于恢复逻辑）
}

function shouldWithhold(message: Message, apiError?: string): boolean {
  // 可恢复错误：413 prompt_too_long、max_output_tokens
  return (
    apiError === 'prompt_too_long' ||
    apiError === 'max_output_tokens'
  )
}

async function* yieldWithWithholding(
  messages: AsyncIterable<Message>,
): AsyncGenerator<Message> {
  const state: WithholdState = { withheldMessages: [], assistantMessages: [] }

  for await (const message of messages) {
    state.assistantMessages.push(message)  // 始终推送到恢复列表

    if (shouldWithhold(message, message.apiError)) {
      state.withheldMessages.push(message)  // 扣留
    } else {
      yield message  // 正常 yield 给 UI
    }
  }
}

// ========== 空闲看门狗 ==========

const STREAM_IDLE_TIMEOUT_MS = 90_000      // 90s 无数据中止
const STREAM_IDLE_WARNING_MS = 45_000      // 45s 警告

class StreamIdleWatchdog {
  private timer: NodeJS.Timeout | null = null
  private onTimeout: () => void

  constructor(onTimeout: () => void) {
    this.onTimeout = onTimeout
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.onTimeout()
    }, STREAM_IDLE_TIMEOUT_MS)
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

// 使用：每收到一个 chunk 就 reset
async function* streamWithWatchdog(
  stream: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  let aborted = false

  const watchdog = new StreamIdleWatchdog(() => {
    aborted = true
  })

  try {
    for await (const event of stream) {
      if (aborted) break
      watchdog.reset()
      yield event
    }
  } finally {
    watchdog.clear()
  }

  if (aborted) {
    // 触发非流式回退
    throw new StreamIdleTimeoutError()
  }
}

// ========== 非流式回退 ==========

async function executeNonStreamingFallback(
  params: APIParams,
  options: { timeout: number },  // 远程 120s / 默认 300s
): Promise<APIResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout)

  try {
    const response = await fetch(params.endpoint, {
      ...params,
      signal: controller.signal,
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}
