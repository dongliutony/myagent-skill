/**
 * 多层 Prompt 组装 + 缓存分区
 *
 * 模式：优先级层次 + 静态/动态边界 + 分区缓存
 * 关键点：
 * - 6 级优先级（Override > Agent > Custom > Default > Append）
 * - 静态内容用全局缓存 scope
 * - 动态内容用组织/会话缓存 scope
 * - 边界标记分隔两个区域
 */

const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// ========== 优先级组装 ==========

type SystemPrompt = readonly string[]  // Branded type for safety

function buildEffectiveSystemPrompt(params: {
  overridePrompt?: string        // 循环模式替换一切
  coordinatorPrompt?: string     // 协调者模式
  agentPrompt?: string           // Agent 定义
  customPrompt?: string          // --system-prompt 标志
  appendPrompt?: string          // 始终追加
  isProactiveMode?: boolean
}): SystemPrompt {
  let prompt: string[]

  if (params.overridePrompt) {
    prompt = [params.overridePrompt]
  } else if (params.coordinatorPrompt) {
    prompt = [params.coordinatorPrompt]
  } else if (params.agentPrompt) {
    if (params.isProactiveMode) {
      prompt = [...getDefaultSystemPrompt(), params.agentPrompt]
    } else {
      prompt = [params.agentPrompt]
    }
  } else if (params.customPrompt) {
    prompt = [params.customPrompt]
  } else {
    prompt = getDefaultSystemPrompt()
  }

  if (params.appendPrompt) {
    prompt = [...prompt, params.appendPrompt]
  }

  return Object.freeze(prompt) as SystemPrompt
}

// ========== 默认 Prompt 组装 ==========

function getDefaultSystemPrompt(): string[] {
  return [
    // ═══ 静态内容（全局缓存） ═══
    getIdentitySection(),           // 身份与能力声明
    getTaskGuidanceSection(),       // 任务执行准则
    getToolUsageSection(),          // 工具使用指导
    getActionSafetySection(),       // 操作安全规则
    getToneStyleSection(),          // 语气风格约定

    // ═══ 边界标记 ═══
    DYNAMIC_BOUNDARY,

    // ═══ 动态内容（组织缓存） ═══
    getSessionGuidanceSection(),    // 会话指导
    loadMemoryPrompt(),             // 记忆系统
    getEnvironmentInfo(),           // 工作目录、OS、git 状态
    getLanguageSection(),           // 用户语言偏好
    getMcpInstructions(),           // MCP 服务器指令
    getToolResultWarning(),         // "工具结果可能被清理" 警告
    getTokenBudgetSection(),        // Token 预算提示（可选）
  ].filter(Boolean)
}

// ========== Prompt 分区类型 ==========

// 记忆化分区 — 缓存直到 /clear 或 /compact
function memoizedSection(generator: () => string): () => string {
  let cached: string | undefined
  return () => {
    if (cached === undefined) cached = generator()
    return cached
  }
}

// 每轮重算分区 — 值变化时破坏缓存
function uncachedSection(generator: () => string): () => string {
  return generator  // 每次调用都重新计算
}

// 用法
const identitySection = memoizedSection(() =>
  'You are an AI assistant that helps with software engineering tasks.'
)
const gitStatusSection = uncachedSection(() =>
  `Current git status: ${getGitStatus()}`
)

// ========== API Prompt 块构建（缓存控制） ==========

type CacheScope = 'global' | 'org'

interface PromptBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '1h'; scope?: CacheScope }
}

function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enableCaching: boolean,
): PromptBlock[] {
  const blocks: PromptBlock[] = []
  let currentScope: CacheScope = 'global'

  for (const part of systemPrompt) {
    if (part === DYNAMIC_BOUNDARY) {
      currentScope = 'org'  // 切换到组织缓存
      continue
    }

    blocks.push({
      type: 'text',
      text: part,
      ...(enableCaching
        ? { cache_control: { type: 'ephemeral', scope: currentScope } }
        : {}),
    })
  }

  return blocks
}
