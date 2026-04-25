/**
 * Agent 核心循环状态机
 *
 * 模式：while(true) AsyncGenerator + 类型化终止/继续状态
 * 关键点：
 * - 循环是 AsyncGenerator，yield 事件而非 return 结果
 * - 每种终止和继续都有明确的 reason
 * - State 携带恢复计数器和防螺旋守卫
 */

// ========== 状态定义 ==========

type TerminalReason =
  | 'completed'            // 模型正常结束
  | 'max_turns'            // 轮次超限
  | 'aborted_streaming'    // 用户中止（流式中）
  | 'aborted_tools'        // 用户中止（工具执行中）
  | 'prompt_too_long'      // 压缩恢复失败
  | 'model_error'          // 未捕获 API 异常
  | 'blocking_limit'       // 硬上下文限制
  | 'stop_hook_prevented'  // Stop Hook 阻止
  | 'hook_stopped'         // Hook 停止信号

type ContinueReason =
  | 'next_turn'                    // 正常工具执行后继续
  | 'collapse_drain_retry'         // Context Collapse 排空后重试
  | 'reactive_compact_retry'       // 全量摘要后重试
  | 'max_output_tokens_escalate'   // 输出 token 升级后重试
  | 'max_output_tokens_recovery'   // 多轮恢复（≤3 次）
  | 'stop_hook_blocking'           // 注入 Hook 错误后重试
  | 'token_budget_continuation'    // 注入预算提醒后继续

type Terminal = { reason: TerminalReason; turnCount?: number; error?: Error }
type Continue = { reason: ContinueReason }

interface LoopState {
  messages: Message[]
  turnCount: number
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean    // 防止压缩螺旋
  maxOutputTokensOverride: number | undefined
  transition: Continue | undefined        // 上一轮继续原因
  stopHookActive: boolean | undefined
}

// ========== 核心循环 ==========

async function* queryLoop(
  params: QueryParams,
  initialState: LoopState,
): AsyncGenerator<LoopEvent, Terminal> {
  let state = initialState

  while (true) {
    // 1. 组装 prompt + 规范化消息
    const systemPrompt = await buildEffectiveSystemPrompt(params)
    const messagesForAPI = normalizeMessages(state.messages)

    // 2. 调用 LLM（流式）
    let apiResult: APIResult
    try {
      apiResult = yield* callModelWithFallback(messagesForAPI, systemPrompt, params)
    } catch (error) {
      if (error instanceof FallbackTriggeredError && params.fallbackModel) {
        // 模型回退 — 见 model-fallback.ts
        yield* handleModelFallback(state, params)
        continue
      }
      return { reason: 'model_error', error: error as Error }
    }

    // 3. 检查中断
    if (params.abortController.signal.aborted) {
      return { reason: 'aborted_streaming' }
    }

    // 4. 处理可恢复错误（413/max_output_tokens）
    const recovery = checkRecoverableErrors(apiResult, state)
    if (recovery) {
      state = { ...state, ...recovery.stateUpdate, transition: recovery.transition }
      continue
    }

    // 5. 处理正常完成
    if (apiResult.stopReason === 'end_turn') {
      // 检查 Stop Hook
      const hookResult = await runStopHooks(state)
      if (hookResult.blockingErrors.length > 0) {
        state.messages.push(...hookResult.blockingErrors)
        state = { ...state, transition: { reason: 'stop_hook_blocking' } }
        continue
      }
      // 检查 Token Budget
      if (params.tokenBudget && !isTokenBudgetExhausted(state)) {
        state.messages.push(createBudgetNudgeMessage())
        state = { ...state, transition: { reason: 'token_budget_continuation' } }
        continue
      }
      return { reason: 'completed' }
    }

    // 6. 执行工具
    if (apiResult.stopReason === 'tool_use') {
      const toolResults = yield* executeTools(apiResult.toolUseBlocks, params)
      state.messages.push(...toolResults)

      if (params.abortController.signal.aborted) {
        return { reason: 'aborted_tools' }
      }
    }

    // 7. 检查轮次限制
    const nextTurnCount = state.turnCount + 1
    if (params.maxTurns && nextTurnCount > params.maxTurns) {
      yield { type: 'max_turns_reached', maxTurns: params.maxTurns }
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    // 8. 推进到下一轮（重置恢复计数器）
    state = {
      ...state,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,  // 成功轮次重置
      transition: { reason: 'next_turn' },
    }
  }
}
