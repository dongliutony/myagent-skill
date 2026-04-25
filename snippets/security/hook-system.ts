/**
 * Hook 系统 — PreToolUse / PostToolUse
 *
 * 模式：事件驱动 + Shell 命令执行 + 决策注入
 * 关键点：
 * - Hook 可审批/阻止/修改输入/修改输出
 * - 支持超时和 abort signal
 * - 原子性注册（clear-then-register）
 * - Hook 信息通过 JSON stdin/stdout 交换
 */

// ========== Hook 事件类型 ==========

type HookEvent =
  | 'PreToolUse'           // 工具执行前
  | 'PostToolUse'          // 工具执行后
  | 'PostToolUseFailure'   // 工具失败后
  | 'PermissionDenied'     // 权限被拒
  | 'FileChanged'          // 文件变更

// ========== Hook 配置 ==========

interface HookConfig {
  event: HookEvent
  command: string                // Shell 命令
  toolNames?: string[]           // 过滤：只对这些工具触发
  timeout?: number               // 超时毫秒
}

// ========== PreToolUse Hook 返回 ==========

interface PreToolUseResult {
  permissionDecision?: 'approve' | 'block'  // 审批/阻止
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>    // 修改工具输入
  additionalContext?: string                // 注入额外上下文
}

// ========== PostToolUse Hook 返回 ==========

interface PostToolUseResult {
  updatedOutput?: string          // 修改工具输出
  additionalContext?: string
}

// ========== Hook 执行引擎 ==========

async function executeHook(
  config: HookConfig,
  payload: HookPayload,
  signal?: AbortSignal,
): Promise<PreToolUseResult | PostToolUseResult | null> {
  const timeout = config.timeout ?? 30_000

  try {
    const result = await withTimeout(
      runShellCommand(config.command, {
        stdin: JSON.stringify(payload),
        signal,
      }),
      timeout,
    )

    if (!result.stdout.trim()) return null
    return JSON.parse(result.stdout)
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.warn(`Hook ${config.command} timed out after ${timeout}ms`)
      return null
    }
    throw error
  }
}

// ========== Hook 注册（原子性） ==========

type RegisteredHook = {
  config: HookConfig
  source: 'settings' | 'plugin' | 'agent'
}

let registeredHooks: Map<HookEvent, RegisteredHook[]> = new Map()

function registerHooks(hooks: RegisteredHook[]): void {
  // 原子性：先清空再注册，防止 "Hook 死亡" 窗口
  const newRegistry = new Map<HookEvent, RegisteredHook[]>()

  for (const hook of hooks) {
    const list = newRegistry.get(hook.config.event) ?? []
    list.push(hook)
    newRegistry.set(hook.config.event, list)
  }

  registeredHooks = newRegistry  // 原子替换
}

// ========== 在工具执行中使用 ==========

async function runPreToolUseHooks(
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<PreToolUseResult | null> {
  const hooks = registeredHooks.get('PreToolUse') ?? []

  for (const hook of hooks) {
    // 过滤：只对匹配的工具触发
    if (hook.config.toolNames && !hook.config.toolNames.includes(toolName)) {
      continue
    }

    const result = await executeHook(
      hook.config,
      { tool_name: toolName, tool_input: input },
      signal,
    )

    if (result?.permissionDecision) {
      return result as PreToolUseResult  // 短路返回
    }
  }

  return null
}
