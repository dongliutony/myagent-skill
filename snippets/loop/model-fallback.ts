/**
 * 模型回退机制
 *
 * 模式：连续过载检测 → 清除状态 → 切换模型 → 重试
 * 关键点：
 * - 连续 3 次 529 过载才触发（不是首次错误）
 * - 切换模型后清除所有助手消息和工具结果
 * - 剥离 thinking signatures（fallback 模型可能不支持）
 * - 创建新的工具执行器
 */

interface FallbackConfig {
  primaryModel: string
  fallbackModel: string
  maxConsecutiveOverloads: number  // 默认 3
}

async function* handleModelFallback(
  state: LoopState,
  executor: StreamingToolExecutor | null,
  config: FallbackConfig,
): AsyncGenerator<Message> {
  // 1. 为未完成的 tool_use 生成缺失 tool_result
  yield* generateMissingToolResults('Model fallback triggered')

  // 2. 清除当前轮的状态
  state.currentAssistantMessages.length = 0
  state.currentToolResults.length = 0
  state.currentToolUseBlocks.length = 0

  // 3. 丢弃执行中的工具
  if (executor) {
    executor.discard()  // 标记为 discarded，排队的工具不再执行
  }

  // 4. 剥离 thinking signatures（fallback 模型兼容性）
  state.messagesForQuery = stripThinkingSignatures(state.messagesForQuery)

  // 5. 切换到 fallback 模型
  state.currentModel = config.fallbackModel
}

// ========== Thinking Signature 剥离 ==========

function stripThinkingSignatures(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg

    return {
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.map(block => {
            if (block.type === 'thinking' && 'signature' in block) {
              const { signature, ...rest } = block
              return rest
            }
            return block
          })
        : msg.content,
    }
  })
}

// ========== 流式回退（中途失败） ==========

interface StreamingFallbackResult {
  tombstoneIds: string[]  // 需要从 UI 移除的消息 ID
  cleanedState: LoopState
}

function handleStreamingFallback(
  orphanedMessages: Message[],
  state: LoopState,
): StreamingFallbackResult {
  // 生成 tombstone 从 UI 移除孤儿消息
  const tombstoneIds = orphanedMessages.map(m => m.id)

  return {
    tombstoneIds,
    cleanedState: {
      ...state,
      messages: state.messages.filter(m => !tombstoneIds.includes(m.id)),
    },
  }
}
