/**
 * 渐进信任模型 — 规则建议 + 反馈闭环
 *
 * 模式：首次审批 → 生成规则建议 → 用户确认 → 后续自动
 * 关键点：
 * - 工具生成 PermissionUpdate 建议
 * - 双向反馈：accept + text / reject + text
 * - 反馈注入到对话上下文
 * - 200ms 恩惠期防误触
 */

// ========== 规则建议生成 ==========

interface PermissionUpdate {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode'
  destination: 'localSettings' | 'userSettings' | 'projectSettings' | 'session'
  rules: Array<{ toolName: string; ruleContent?: string }>
  behavior: 'allow' | 'deny'
}

// 示例：Shell 命令建议
function generateBashSuggestions(command: string): PermissionUpdate[] {
  // 提取命令前缀作为规则
  const prefix = command.split(' ')[0]  // 如 "npm"
  return [{
    type: 'addRules',
    destination: 'localSettings',
    rules: [{ toolName: 'bash', ruleContent: command }],  // 精确匹配
    behavior: 'allow',
  }, {
    type: 'addRules',
    destination: 'localSettings',
    rules: [{ toolName: 'bash', ruleContent: `${prefix} *` }],  // 宽泛匹配
    behavior: 'allow',
  }]
}

// 示例：文件编辑建议
function generateEditSuggestions(filePath: string): PermissionUpdate[] {
  const dir = path.dirname(filePath)
  return [{
    type: 'addRules',
    destination: 'localSettings',
    rules: [{ toolName: 'edit', ruleContent: `${dir}/**` }],
    behavior: 'allow',
  }]
}

// ========== 双向反馈收集 ==========

type FeedbackType = 'accept' | 'reject'

interface FeedbackConfig {
  type: FeedbackType
  placeholder: string
}

const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: 'tell the agent what to do next',
  reject: 'tell the agent what to do differently',
}

// 接受 + 反馈
function handleAcceptWithFeedback(
  input: unknown,
  permissionUpdates: PermissionUpdate[],
  feedback?: string,
): PermissionDecision {
  // 应用规则更新
  for (const update of permissionUpdates) {
    applyPermissionUpdate(update)
  }

  return {
    behavior: 'allow',
    updatedInput: input,
    // 反馈注入到对话上下文
    ...(feedback ? { acceptFeedback: feedback } : {}),
  }
}

// 拒绝 + 反馈
function handleRejectWithFeedback(
  feedback?: string,
): void {
  // 取消当前操作并注入反馈
  cancelAndAbort(feedback)
}

// ========== 竞赛解决器（多决策源） ==========

function createResolveOnce<T>(resolve: (value: T) => void) {
  let resolved = false

  return {
    resolve: (value: T) => {
      if (!resolved) {
        resolved = true
        resolve(value)
      }
    },
    isResolved: () => resolved,
    // 首个 claim 获胜
    claim: () => {
      if (resolved) return false
      resolved = true
      return true
    },
  }
}

// 竞赛源：
// 1. 用户操作（allow/reject）
// 2. Hook 决策
// 3. 分类器自动审批
// 4. 远程桥接响应
// 5. Abort signal

const GRACE_PERIOD_MS = 200  // 防止启动时误触

function handleInteraction(
  startTimeMs: number,
  resolveOnce: ReturnType<typeof createResolveOnce>,
): void {
  // 恩惠期内忽略交互
  if (Date.now() - startTimeMs < GRACE_PERIOD_MS) return

  // 标记用户已交互 → 取消分类器检查
  clearClassifierChecking()
  resolveOnce.claim()
}

// ========== 异步非阻塞分类器 ==========

interface ClassifierResult {
  matches: boolean
  matchedDescription: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

// 分类器在后台运行，UI 同时展示
// 高置信度 → 自动关闭对话框 + ✔
// 低置信度 → 保持对话框等待用户
async function runClassifierInBackground(
  tool: Tool,
  input: unknown,
  onResult: (result: ClassifierResult) => void,
): Promise<void> {
  const result = await classifyToolUse(tool, input)
  onResult(result)
}
