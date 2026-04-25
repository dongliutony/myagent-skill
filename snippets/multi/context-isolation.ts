/**
 * 多 Agent 上下文隔离 — AsyncLocalStorage + 选择性共享
 *
 * 模式：线程本地上下文 + 子 Agent 默认隔离 + 显式 opt-in 共享
 * 关键点：
 * - AsyncLocalStorage 为每个 Agent 提供独立上下文
 * - 子代理默认：readFileState 克隆、setAppState no-op、新 AbortController
 * - 异步子代理独立 AbortController（父级中止不影响）
 * - 权限继承：严格模式不被子级覆盖
 */

import { AsyncLocalStorage } from 'async_hooks'

// ========== 线程本地上下文 ==========

interface AgentContext {
  agentId: string
  agentName: string
  teamName: string
  parentSessionId: string
  abortController: AbortController
  cwd: string
}

const agentContextStorage = new AsyncLocalStorage<AgentContext>()

function runWithAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  return agentContextStorage.run(ctx, fn)
}

function getCurrentAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}

// CWD 隔离
const cwdOverrideStorage = new AsyncLocalStorage<string>()

function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

function getCwd(): string {
  return cwdOverrideStorage.getStore() ?? getGlobalCwd()
}

// ========== 子代理上下文创建 ==========

interface SubagentOverrides {
  agentId: string
  agentType: string
  isAsync: boolean
  shareSetAppState?: boolean      // 默认 false（no-op）
  shareAbortController?: boolean  // 默认 false
}

function createSubagentContext(
  parentCtx: ToolUseContext,
  overrides: SubagentOverrides,
): ToolUseContext {
  // AbortController：异步子代理独立，同步子代理共享父级
  const abortController = overrides.shareAbortController
    ? parentCtx.abortController
    : overrides.isAsync
      ? new AbortController()  // 完全独立
      : createChildAbortController(parentCtx.abortController)  // 链接到父级

  return {
    ...parentCtx,
    agentId: overrides.agentId,

    // 状态：克隆（隔离）
    readFileState: new Map(parentCtx.readFileState),  // 新快照
    taskDecisions: new Set(),  // 新 Set

    // AppState：默认 no-op
    setAppState: overrides.shareSetAppState
      ? parentCtx.setAppState
      : () => {},  // no-op

    // 中止控制器
    abortController,

    // 权限：自动设置 shouldAvoidPermissionPrompts
    getAppState: () => ({
      ...parentCtx.getAppState(),
      shouldAvoidPermissionPrompts: true,
    }),

    // 层级追踪
    queryTracking: {
      chainId: crypto.randomUUID(),
      depth: parentCtx.queryTracking.depth + 1,
    },
  }
}

// ========== 权限继承 ==========

function resolveChildPermissionMode(
  parentMode: PermissionMode,
  agentMode: PermissionMode | undefined,
  isAsync: boolean,
): PermissionMode {
  // 父级严格模式不被覆盖
  if (parentMode === 'bypassPermissions' ||
      parentMode === 'acceptEdits' ||
      parentMode === 'auto') {
    return parentMode
  }

  // 有显式 Agent 模式 → 使用它
  if (agentMode) return agentMode

  // 异步 + 无 UI → 自动 deny（bubble 除外）
  if (isAsync) return 'dontAsk'

  return parentMode
}

// ========== 资源限制 ==========

const AGENT_MESSAGES_UI_CAP = 50  // UI 消息缓冲上限

function appendCappedMessage<T>(prev: T[], item: T): T[] {
  if (prev.length >= AGENT_MESSAGES_UI_CAP) {
    return [...prev.slice(-(AGENT_MESSAGES_UI_CAP - 1)), item]
  }
  return [...prev, item]
}
