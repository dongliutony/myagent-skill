/**
 * Token 预算控制 + 收益递减检测
 *
 * 模式：预算跟踪 → 阈值判断 → 收益递减检测 → 停止/继续
 * 关键点：
 * - 90% 为完成阈值
 * - 连续 3+ 次继续且每次 < 500 token → 收益递减
 * - 继续时注入提醒消息
 */

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_RETURNS_MIN_CONTINUATIONS = 3
const DIMINISHING_RETURNS_MIN_DELTA = 500

interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

type BudgetAction =
  | { action: 'continue'; nudgeMessage: Message }
  | { action: 'stop'; reason: 'budget_exhausted' | 'diminishing_returns' }

function checkTokenBudget(
  tracker: BudgetTracker,
  budgetTokens: number,
  currentTokens: number,
): BudgetAction {
  const usage = currentTokens / budgetTokens

  // 收益递减检测
  if (tracker.continuationCount >= DIMINISHING_RETURNS_MIN_CONTINUATIONS
      && tracker.lastDeltaTokens < DIMINISHING_RETURNS_MIN_DELTA) {
    return { action: 'stop', reason: 'diminishing_returns' }
  }

  // 预算耗尽
  if (usage >= COMPLETION_THRESHOLD) {
    return { action: 'stop', reason: 'budget_exhausted' }
  }

  // 继续 — 注入提醒
  return {
    action: 'continue',
    nudgeMessage: {
      role: 'user',
      content: `You have used ${Math.round(usage * 100)}% of your token budget. `
        + `Continue working efficiently.`,
    },
  }
}

function updateBudgetTracker(
  tracker: BudgetTracker,
  currentTokens: number,
): BudgetTracker {
  return {
    ...tracker,
    continuationCount: tracker.continuationCount + 1,
    lastDeltaTokens: currentTokens - tracker.lastGlobalTurnTokens,
    lastGlobalTurnTokens: currentTokens,
  }
}
