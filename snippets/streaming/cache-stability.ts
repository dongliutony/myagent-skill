/**
 * Prompt Cache 稳定性 — 失效检测 + hash 追踪
 *
 * 模式：多维 hash 追踪 + 最小显著下降检测 + diff 生成
 * 关键点：
 * - 追踪 system prompt hash、tool hash、cache control hash
 * - 最小显著下降 2000 token
 * - Schema 排序固定 + Feature Flag 按会话锁定
 * - Fork 子代理字节一致前缀
 */

const MIN_CACHE_MISS_TOKENS = 2000  // 低于此值不报告失效
const CACHE_TTL_5MIN_MS = 300_000
const CACHE_TTL_1HOUR_MS = 3_600_000

// ========== 缓存状态追踪 ==========

interface CacheTrackingState {
  systemHash: string
  toolsHash: string
  cacheControlHash: string
  toolNames: string[]
  perToolHashes: Record<string, string>
  model: string
  fastMode: boolean
  betas: string[]
  callCount: number
  prevCacheReadTokens: number
}

// ========== 失效检测 ==========

interface CacheBreakEvent {
  type: 'cache_break_detected'
  tokenDrop: number
  changes: string[]   // 哪些维度变化了
}

function detectCacheBreak(
  prev: CacheTrackingState,
  current: CacheTrackingState,
  cacheReadTokens: number,
): CacheBreakEvent | null {
  const tokenDrop = prev.prevCacheReadTokens - cacheReadTokens

  // 低于最小显著阈值 — 忽略
  if (tokenDrop < MIN_CACHE_MISS_TOKENS) return null

  // 检查哪些维度变化
  const changes: string[] = []
  if (prev.systemHash !== current.systemHash) changes.push('system_prompt')
  if (prev.toolsHash !== current.toolsHash) changes.push('tools')
  if (prev.model !== current.model) changes.push('model')
  if (prev.fastMode !== current.fastMode) changes.push('fast_mode')
  if (prev.cacheControlHash !== current.cacheControlHash) changes.push('cache_control')
  if (JSON.stringify(prev.betas) !== JSON.stringify(current.betas)) changes.push('betas')

  if (changes.length === 0) return null  // 未知原因

  return { type: 'cache_break_detected', tokenDrop, changes }
}

// ========== 稳定性保障措施 ==========

// 1. 工具 Schema 排序固定
function sortToolsForCacheStability(tools: Tool[]): Tool[] {
  // 内置工具作为连续前缀
  const builtin = tools.filter(t => !t.isMcp).sort((a, b) => a.name.localeCompare(b.name))
  const mcp = tools.filter(t => t.isMcp).sort((a, b) => a.name.localeCompare(b.name))
  return [...builtin, ...mcp]
}

// 2. Feature Flag 按会话锁定
const sessionFlagValues = new Map<string, unknown>()

function getFeatureValueLocked<T>(flag: string, defaultValue: T): T {
  if (sessionFlagValues.has(flag)) {
    return sessionFlagValues.get(flag) as T
  }
  const value = getFeatureValue(flag, defaultValue)
  sessionFlagValues.set(flag, value)  // 锁定
  return value
}

// 3. Fork 子代理字节一致前缀
function buildForkedMessages(
  parentMessages: Message[],
  toolUseBlocks: ToolUseBlock[],
): Message[] {
  // 为每个 tool_use 生成占位符结果
  // 所有 fork 生成相同的占位符 → 字节一致 → cache 共享
  const placeholderResults = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: 'Fork started — processing in background',
  }))

  return [...parentMessages, ...placeholderResults]
}

// ========== Cache TTL 选择 ==========

function getCacheTTL(userType: string, isSubscriber: boolean): string | undefined {
  // 订阅用户使用 1 小时 TTL
  if (isSubscriber) return '1h'
  // 内部用户使用 1 小时
  if (userType === 'internal') return '1h'
  // 其他使用默认 5 分钟
  return undefined
}
