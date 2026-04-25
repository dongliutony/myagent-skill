/**
 * 六阶段权限决策级联
 *
 * 模式：规则 → 模式 → 快速路径 → 白名单 → 分类器 → 用户
 * 关键点：
 * - 每一阶段可短路返回
 * - 分类器异步非阻塞
 * - 拒绝跟踪 + 自适应回退
 * - 决策携带完整溯源
 */

type PermissionMode =
  | 'default' | 'acceptEdits' | 'bypassPermissions'
  | 'dontAsk' | 'plan' | 'auto' | 'bubble'

type DecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'classifier'; name: string; confidence: string; reason: string }
  | { type: 'hook'; hookName: string; reason?: string }
  | { type: 'user_action'; action: 'allow' | 'deny' }

interface PermissionDecision {
  behavior: 'allow' | 'deny' | 'ask'
  reason: DecisionReason
  updatedInput?: unknown
  suggestions?: PermissionSuggestion[]
}

// ========== 规则来源 ==========

type RuleSource =
  | 'policySettings'    // 企业策略（最高优先）
  | 'userSettings'      // 用户设置
  | 'projectSettings'   // 项目设置
  | 'localSettings'     // 本地设置
  | 'flagSettings'      // Feature Flag
  | 'cliArg'            // CLI 参数
  | 'command'           // 命令级
  | 'session'           // 会话级

interface PermissionRule {
  source: RuleSource
  behavior: 'allow' | 'deny' | 'ask'
  toolName: string
  ruleContent?: string   // 如 "npm test" 或 "/src/**"
}

// ========== 六阶段级联 ==========

async function resolvePermission(
  tool: Tool,
  input: unknown,
  context: PermissionContext,
): Promise<PermissionDecision> {

  // 阶段 1：配置规则匹配
  const ruleMatch = matchRules(tool.name, input, context.rules)
  if (ruleMatch) {
    return {
      behavior: ruleMatch.behavior,
      reason: { type: 'rule', rule: ruleMatch },
    }
  }

  // 阶段 2：模式检测
  switch (context.mode) {
    case 'bypassPermissions':
      return { behavior: 'allow', reason: { type: 'mode', mode: context.mode } }
    case 'dontAsk':
      return { behavior: 'deny', reason: { type: 'mode', mode: context.mode } }
    case 'plan':
      if (!tool.isReadOnly(input)) {
        return { behavior: 'deny', reason: { type: 'mode', mode: 'plan' } }
      }
      break
    case 'auto':
      break  // 继续到分类器
    case 'default':
      if (tool.isReadOnly(input)) {
        return { behavior: 'allow', reason: { type: 'mode', mode: 'default' } }
      }
      break
  }

  // 阶段 3：acceptEdits 快速路径
  if (context.mode === 'auto' || context.mode === 'acceptEdits') {
    if (isEditTool(tool) && isWithinWorkingDirectory(input, context.cwd)) {
      return { behavior: 'allow', reason: { type: 'mode', mode: 'acceptEdits' } }
    }
  }

  // 阶段 4：安全白名单
  if (SAFE_ALLOWLISTED_TOOLS.has(tool.name)) {
    return { behavior: 'allow', reason: { type: 'mode', mode: context.mode } }
  }

  // 阶段 5：异步分类器（auto 模式）
  if (context.mode === 'auto') {
    const classifierResult = await runClassifier(tool, input)
    if (classifierResult.confidence === 'high') {
      return {
        behavior: 'allow',
        reason: {
          type: 'classifier',
          name: classifierResult.name,
          confidence: 'high',
          reason: classifierResult.matchedDescription,
        },
      }
    }
    // 低置信度 → 继续到用户
  }

  // 阶段 6：用户交互
  return {
    behavior: 'ask',
    reason: { type: 'mode', mode: context.mode },
    suggestions: generateRuleSuggestions(tool, input),
  }
}

// ========== 拒绝跟踪 + 自适应回退 ==========

interface DenialTracker {
  consecutiveDenials: number
  totalDenials: number
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续 3 次 → 回退交互
  maxTotal: 20,        // 总计 20 次 → 回退交互
}

function shouldFallbackToPrompting(tracker: DenialTracker): boolean {
  return (
    tracker.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    tracker.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}

// ========== 规则匹配 ==========

function matchRules(
  toolName: string,
  input: unknown,
  rules: { allow: PermissionRule[]; deny: PermissionRule[]; ask: PermissionRule[] },
): PermissionRule | null {
  // Deny 优先检查
  for (const rule of rules.deny) {
    if (ruleMatchesTool(rule, toolName, input)) return rule
  }
  // Allow 次之
  for (const rule of rules.allow) {
    if (ruleMatchesTool(rule, toolName, input)) return rule
  }
  return null
}

function ruleMatchesTool(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
): boolean {
  if (rule.toolName !== toolName && rule.toolName !== '*') return false
  if (!rule.ruleContent) return true  // 无内容 = blanket 规则
  // 具体匹配（如 "npm test" 匹配 bash 命令，"/src/**" 匹配路径）
  return matchRuleContent(rule.ruleContent, input)
}
