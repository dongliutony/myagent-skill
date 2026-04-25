/**
 * 中断信号传播机制
 *
 * 模式：AbortController 树形传播 + 工具级中断行为声明
 * 关键点：
 * - 父级 abort 传播到所有子级
 * - 子级可独立 abort 不影响父级
 * - 每个工具声明 interruptBehavior: 'cancel' | 'block'
 * - 区分不同中断原因
 */

type AbortReason = 'user_interrupted' | 'streaming_fallback' | 'sibling_error'

// ========== 子 AbortController 链接 ==========

function createChildAbortController(parent: AbortController): AbortController {
  const child = new AbortController()

  // 父级中止 → 子级也中止
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
  } else {
    parent.signal.addEventListener('abort', () => {
      child.abort(parent.signal.reason)
    }, { once: true })
  }

  return child  // 子级可独立 abort，不影响父级
}

// ========== 工具中断行为 ==========

type InterruptBehavior = 'cancel' | 'block'

interface Tool {
  name: string
  interruptBehavior(): InterruptBehavior
  // cancel → 立即取消，生成合成错误结果
  // block  → 等待完成后再响应中断
}

// ========== 中断后清理 ==========

async function* handleAbortDuringStreaming(
  executor: StreamingToolExecutor,
  abortReason: AbortReason,
): AsyncGenerator<Message> {
  if (executor) {
    // 消费剩余结果 — 执行器为被取消的工具生成合成 tool_results
    for await (const update of executor.getRemainingResults()) {
      if (update.message) yield update.message
    }
  } else {
    // 无执行器 — 为未匹配的 tool_use 生成缺失 tool_result
    yield* generateMissingToolResults('Interrupted by user')
  }
}

async function* handleAbortDuringTools(
  toolUseContext: ToolUseContext,
  abortReason: AbortReason,
): AsyncGenerator<Message> {
  // Submit-interrupt 跳过中断消息（用户在输入中替代）
  if (abortReason !== 'interrupt') {
    yield createUserInterruptionMessage({ toolUse: true })
  }

  // 清理资源
  await cleanupResources(toolUseContext)
}

// ========== 合成错误消息（被中断的工具） ==========

function createSyntheticErrorMessage(
  toolUseId: string,
  reason: AbortReason,
): ToolResultMessage {
  const messages: Record<AbortReason, string> = {
    user_interrupted: 'Tool execution interrupted by user',
    streaming_fallback: 'Streaming fallback - tool execution discarded',
    sibling_error: 'Tool cancelled due to error in parallel tool execution',
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: messages[reason],
    is_error: true,
  }
}
