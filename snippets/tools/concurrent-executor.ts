/**
 * 流式工具并发执行器
 *
 * 模式：队列处理器 + 安全性分区 + 进度解耦
 * 关键点：
 * - 只读工具并行，写入工具串行
 * - 进度消息绕过排序立即 yield
 * - Bash 错误级联取消并行兄弟，只读错误不级联
 * - 被取消的工具生成合成错误结果
 */

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

interface QueuedTool {
  id: string
  name: string
  input: unknown
  status: ToolStatus
  isConcurrencySafe: boolean
  pendingProgress: ProgressMessage[]
  resultMessages: Message[]
  promise?: Promise<void>
}

class StreamingToolExecutor {
  private tools: QueuedTool[] = []
  private discarded = false
  private hasErrored = false
  private siblingAbortController = new AbortController()
  private progressAvailableResolve?: () => void

  // ========== 入队 ==========

  enqueue(tool: QueuedTool): void {
    this.tools.push(tool)
    this.processQueue()
  }

  // ========== 丢弃（模型回退时调用） ==========

  discard(): void {
    this.discarded = true
    // 排队中的工具不再执行
  }

  // ========== 并发安全性检查 ==========

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing')
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    )
  }

  // ========== 队列处理 ==========

  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue
      if (this.discarded) break

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        tool.status = 'executing'
        tool.promise = this.executeTool(tool)  // Fire-and-forget
      } else {
        if (!tool.isConcurrencySafe) break  // 保序：遇到写工具就停
      }
    }
  }

  // ========== 单工具执行 ==========

  private async executeTool(tool: QueuedTool): Promise<void> {
    try {
      // 检查中止
      const abortReason = this.getAbortReason(tool)
      if (abortReason) {
        tool.resultMessages.push(
          createSyntheticError(tool.id, abortReason)
        )
        tool.status = 'completed'
        return
      }

      // 执行工具，收集结果和进度
      const generator = callTool(tool)
      for await (const update of generator) {
        if (update.type === 'progress') {
          tool.pendingProgress.push(update)
          this.progressAvailableResolve?.()  // 唤醒等待的消费者
        } else {
          tool.resultMessages.push(update)
        }
      }

      tool.status = 'completed'
    } catch (error) {
      // Bash 错误级联到并行兄弟
      if (tool.name === 'bash') {
        this.hasErrored = true
        this.siblingAbortController.abort('sibling_error')
      }
      // 只读工具错误不级联 — 独立失败

      tool.resultMessages.push({
        type: 'tool_result',
        tool_use_id: tool.id,
        content: String(error),
        is_error: true,
      })
      tool.status = 'completed'
    }

    // 尝试启动下一个排队工具
    this.processQueue()
  }

  // ========== 结果消费（双 Generator） ==========

  // 同步 — 按顺序 yield 已完成工具的结果
  *getCompletedResults(): Generator<ToolUpdate> {
    for (const tool of this.tools) {
      // 始终先 yield 进度（绕过排序）
      while (tool.pendingProgress.length > 0) {
        yield { message: tool.pendingProgress.shift()! }
      }

      if (tool.status === 'completed' && tool.status !== 'yielded') {
        for (const msg of tool.resultMessages) {
          yield { message: msg }
        }
        tool.status = 'yielded' as ToolStatus
      } else {
        break  // 遇到未完成的工具就停止（保序）
      }
    }
  }

  // 异步 — 等待工具完成
  async *getRemainingResults(): AsyncGenerator<ToolUpdate> {
    while (true) {
      // 先 yield 已就绪的结果
      yield* this.getCompletedResults()

      // 检查是否全部完成
      const executing = this.tools.filter(t =>
        t.status === 'executing' || t.status === 'queued'
      )
      if (executing.length === 0) break

      // 等待：任意工具完成 OR 新进度消息
      const progressPromise = new Promise<void>(resolve => {
        this.progressAvailableResolve = resolve
      })
      const executingPromises = executing
        .filter(t => t.promise)
        .map(t => t.promise!)

      await Promise.race([...executingPromises, progressPromise])
    }

    // 最终一次 yield
    yield* this.getCompletedResults()
  }

  // ========== 中止原因判定 ==========

  private getAbortReason(tool: QueuedTool): AbortReason | null {
    if (this.discarded) return 'streaming_fallback'
    if (this.hasErrored && this.siblingAbortController.signal.aborted) {
      return 'sibling_error'
    }
    return null
  }
}
