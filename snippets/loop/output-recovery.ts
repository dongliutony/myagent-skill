/**
 * 输出 Token 恢复 — 多轮递进策略
 *
 * 模式：升级 → 多轮恢复 → 放弃
 * 关键点：
 * - 第一次命中：从默认值升级到更高上限（如 8k → 64k）
 * - 后续命中：注入 "继续" 消息，最多 3 次
 * - 成功的下一轮重置计数器
 */

const MAX_RECOVERY_ATTEMPTS = 3
const DEFAULT_MAX_TOKENS = 8_000
const ESCALATED_MAX_TOKENS = 64_000

interface RecoveryState {
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
}

type RecoveryAction =
  | { action: 'escalate'; newMaxTokens: number }
  | { action: 'multi_turn_recovery'; recoveryMessage: Message }
  | { action: 'give_up' }

function handleMaxOutputTokensHit(state: RecoveryState): RecoveryAction {
  // 阶段 1：首次命中 → 升级 token 上限
  if (state.maxOutputTokensOverride === undefined) {
    return {
      action: 'escalate',
      newMaxTokens: ESCALATED_MAX_TOKENS,
    }
  }

  // 阶段 2：多轮恢复 → 注入 "继续" 消息
  if (state.maxOutputTokensRecoveryCount < MAX_RECOVERY_ATTEMPTS) {
    return {
      action: 'multi_turn_recovery',
      recoveryMessage: {
        role: 'user',
        content: 'Output token limit hit. Resume directly from where you left off. '
          + 'Do not repeat any previous content. Continue the response seamlessly.',
      },
    }
  }

  // 阶段 3：放弃
  return { action: 'give_up' }
}

// ========== 在循环中使用 ==========

function applyRecovery(
  state: LoopState,
  action: RecoveryAction,
): { newState: LoopState; shouldContinue: boolean } {
  switch (action.action) {
    case 'escalate':
      return {
        newState: {
          ...state,
          maxOutputTokensOverride: action.newMaxTokens,
          transition: { reason: 'max_output_tokens_escalate' },
        },
        shouldContinue: true,
      }

    case 'multi_turn_recovery':
      return {
        newState: {
          ...state,
          messages: [...state.messages, action.recoveryMessage],
          maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
          transition: { reason: 'max_output_tokens_recovery' },
        },
        shouldContinue: true,
      }

    case 'give_up':
      return { newState: state, shouldContinue: false }
  }
}

// 成功轮次重置计数器（在循环推进时调用）
function resetRecoveryOnSuccess(state: LoopState): LoopState {
  return { ...state, maxOutputTokensRecoveryCount: 0 }
}
