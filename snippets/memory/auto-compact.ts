/**
 * 自动压缩触发器 + 断路器
 *
 * 模式：阈值检测 → 自动触发 → 失败计数 → 断路器
 * 关键点：
 * - token ≥ 窗口 - 13k 时触发
 * - 连续失败 3 次后断路器开启
 * - 不同阈值对应不同严重级别
 */

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER = 20_000
const ERROR_THRESHOLD_BUFFER = 20_000
const MANUAL_COMPACT_BUFFER = 3_000          // 手动 /compact 更紧
const MAX_CONSECUTIVE_FAILURES = 3
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// ========== 有效上下文窗口计算 ==========

function getEffectiveContextWindow(
  model: string,
  maxOutputTokens: number,
): number {
  const contextWindow = getContextWindowForModel(model)  // 如 200_000
  const reservedForSummary = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)

  // 支持环境变量覆盖
  const override = process.env.AUTO_COMPACT_WINDOW
  if (override) return parseInt(override, 10) - reservedForSummary

  return contextWindow - reservedForSummary
}

// ========== 状态跟踪 ==========

interface AutoCompactTracker {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures: number  // 断路器计数
}

// ========== 阈值检测 ==========

type CompactUrgency = 'none' | 'warning' | 'error' | 'auto_compact' | 'blocking'

function checkCompactUrgency(
  currentTokens: number,
  effectiveWindow: number,
): CompactUrgency {
  const remaining = effectiveWindow - currentTokens

  if (remaining <= MANUAL_COMPACT_BUFFER) return 'blocking'
  if (remaining <= AUTOCOMPACT_BUFFER_TOKENS) return 'auto_compact'
  if (remaining <= ERROR_THRESHOLD_BUFFER) return 'error'
  if (remaining <= WARNING_THRESHOLD_BUFFER) return 'warning'
  return 'none'
}

// ========== 自动压缩执行 ==========

async function maybeAutoCompact(
  tracker: AutoCompactTracker,
  currentTokens: number,
  effectiveWindow: number,
  messages: Message[],
): Promise<{ compacted: boolean; tracker: AutoCompactTracker }> {
  const urgency = checkCompactUrgency(currentTokens, effectiveWindow)

  if (urgency !== 'auto_compact' && urgency !== 'blocking') {
    return { compacted: false, tracker }
  }

  // 断路器检查
  if (tracker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn('Auto-compact circuit breaker open. Skipping.')
    return { compacted: false, tracker }
  }

  try {
    const summary = await compactMessages(messages)
    return {
      compacted: true,
      tracker: {
        ...tracker,
        compacted: true,
        consecutiveFailures: 0,  // 成功重置
      },
    }
  } catch (error) {
    return {
      compacted: false,
      tracker: {
        ...tracker,
        consecutiveFailures: tracker.consecutiveFailures + 1,
      },
    }
  }
}

// ========== Prompt-Too-Long 恢复（两阶段） ==========

interface RecoveryState {
  hasAttemptedReactiveCompact: boolean
}

async function recoverFromPromptTooLong(
  messages: Message[],
  state: RecoveryState,
): Promise<
  | { recovered: true; transition: ContinueReason; newState: RecoveryState }
  | { recovered: false }
> {
  // 阶段 1：Context Collapse 排空（轻量恢复）
  const collapseDrained = await tryDrainContextCollapse(messages)
  if (collapseDrained) {
    return {
      recovered: true,
      transition: 'collapse_drain_retry',
      newState: state,
    }
  }

  // 阶段 2：Reactive Compact（全量摘要）
  if (!state.hasAttemptedReactiveCompact) {
    const compacted = await tryReactiveCompact(messages)
    if (compacted) {
      return {
        recovered: true,
        transition: 'reactive_compact_retry',
        newState: { ...state, hasAttemptedReactiveCompact: true },
      }
    }
  }

  // 两阶段都失败
  return { recovered: false }
}
