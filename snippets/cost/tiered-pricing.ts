/**
 * 分级定价模型 + 成本追踪 + 预算控制
 *
 * 模式：定价层级 → per-model 追踪 → 预算硬限制 + 收益递减
 * 关键点：
 * - 缓存读取仅 10%，写入 25%
 * - 快速模式 6x 成本 + 限流冷却
 * - --max-budget-usd 硬限制
 * - 收益递减检测（3 次 × <500 token）
 */

// ========== 定价层级 ==========

interface PricingTier {
  inputPerMTok: number
  outputPerMTok: number
  cacheWriteMultiplier: number   // 占输入成本的比例
  cacheReadMultiplier: number
  webSearchPerRequest: number
}

const PRICING_TIERS: Record<string, PricingTier> = {
  haiku:    { inputPerMTok: 1,   outputPerMTok: 5,   cacheWriteMultiplier: 0.25, cacheReadMultiplier: 0.10, webSearchPerRequest: 0.01 },
  sonnet:   { inputPerMTok: 3,   outputPerMTok: 15,  cacheWriteMultiplier: 0.25, cacheReadMultiplier: 0.10, webSearchPerRequest: 0.01 },
  opus:     { inputPerMTok: 15,  outputPerMTok: 75,  cacheWriteMultiplier: 0.25, cacheReadMultiplier: 0.10, webSearchPerRequest: 0.01 },
  opus_fast:{ inputPerMTok: 30,  outputPerMTok: 150, cacheWriteMultiplier: 0.25, cacheReadMultiplier: 0.10, webSearchPerRequest: 0.01 },
}

// ========== 成本计算 ==========

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  webSearchRequests: number
}

function calculateCostUSD(usage: TokenUsage, tier: PricingTier): number {
  const inputCost = (usage.inputTokens / 1_000_000) * tier.inputPerMTok
  const outputCost = (usage.outputTokens / 1_000_000) * tier.outputPerMTok
  const cacheWriteCost = (usage.cacheCreationInputTokens / 1_000_000)
    * tier.inputPerMTok * tier.cacheWriteMultiplier
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000)
    * tier.inputPerMTok * tier.cacheReadMultiplier
  const searchCost = usage.webSearchRequests * tier.webSearchPerRequest

  return inputCost + outputCost + cacheWriteCost + cacheReadCost + searchCost
}

// ========== 成本追踪状态 ==========

interface CostTracker {
  totalCostUSD: number
  totalAPIDuration: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
  }>
}

function addToSessionCost(
  tracker: CostTracker,
  model: string,
  usage: TokenUsage,
  apiDuration: number,
): CostTracker {
  const tier = getTierForModel(model)
  const cost = calculateCostUSD(usage, tier)

  const prev = tracker.modelUsage[model] ?? {
    inputTokens: 0, outputTokens: 0,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0,
  }

  return {
    ...tracker,
    totalCostUSD: tracker.totalCostUSD + cost,
    totalAPIDuration: tracker.totalAPIDuration + apiDuration,
    modelUsage: {
      ...tracker.modelUsage,
      [model]: {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
        cacheReadInputTokens: prev.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens: prev.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        webSearchRequests: prev.webSearchRequests + usage.webSearchRequests,
        costUSD: prev.costUSD + cost,
      },
    },
  }
}

// ========== 快速模式经济学 ==========

type CooldownReason = 'rate_limit' | 'overloaded'

interface FastModeState {
  enabled: boolean
  inCooldown: boolean
  cooldownReason?: CooldownReason
  cooldownExpiresAt?: number
}

function triggerFastModeCooldown(
  state: FastModeState,
  reason: CooldownReason,
  cooldownMs: number,
): FastModeState {
  return {
    ...state,
    inCooldown: true,
    cooldownReason: reason,
    cooldownExpiresAt: Date.now() + cooldownMs,
  }
}

// 可用性检查链
function isFastModeAvailable(checks: {
  featureFlagEnabled: boolean
  isFirstPartyAPI: boolean
  orgEnabled: boolean
  subscriptionTierSufficient: boolean
  overageBillingEnabled: boolean
}): boolean {
  return (
    checks.featureFlagEnabled &&
    checks.isFirstPartyAPI &&
    checks.orgEnabled &&
    checks.subscriptionTierSufficient &&
    checks.overageBillingEnabled
  )
}

// ========== 预算硬限制 ==========

function checkBudgetLimit(
  tracker: CostTracker,
  maxBudgetUsd: number | undefined,
): { exceeded: boolean; message?: string } {
  if (!maxBudgetUsd) return { exceeded: false }

  if (tracker.totalCostUSD >= maxBudgetUsd) {
    return {
      exceeded: true,
      message: `Budget limit of $${maxBudgetUsd} exceeded. `
        + `Total cost: $${tracker.totalCostUSD.toFixed(4)}`,
    }
  }
  return { exceeded: false }
}
