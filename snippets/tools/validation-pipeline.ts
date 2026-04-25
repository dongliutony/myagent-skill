/**
 * 三阶段验证流水线
 *
 * 模式：结构校验 → 业务校验 → 权限校验
 * 关键点：
 * - 每层有独立的返回类型和错误处理
 * - 验证失败返回 is_error: true 的工具结果
 * - 权限检查可返回修改后的输入（updatedInput）
 * - 权限建议可帮助用户建立永久规则
 */

import { z } from 'zod'

// ========== 阶段 1：结构校验（Zod） ==========

function validateStructure(
  tool: Tool,
  rawInput: unknown,
): { success: true; data: unknown } | { success: false; error: ToolResultMessage } {
  const result = tool.inputSchema.safeParse(rawInput)

  if (!result.success) {
    return {
      success: false,
      error: {
        type: 'tool_result',
        tool_use_id: rawInput?.tool_use_id,
        content: `Invalid input: ${result.error.message}`,
        is_error: true,
      },
    }
  }

  return { success: true, data: result.data }
}

// ========== 阶段 2：业务校验 ==========

async function validateBusiness(
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
): Promise<
  | { valid: true }
  | { valid: false; error: ToolResultMessage }
> {
  if (!tool.validateInput) return { valid: true }

  const result = await tool.validateInput(input, context)

  if (!result.result) {
    return {
      valid: false,
      error: {
        type: 'tool_result',
        tool_use_id: context.toolUseId,
        content: result.message,
        is_error: true,
        errorCode: result.errorCode,
      },
    }
  }

  return { valid: true }
}

// 示例业务校验规则：
const EXAMPLE_VALIDATIONS = {
  // 路径存在性检查
  pathExists: (path: string) => fs.existsSync(path),
  // 文件大小限制
  fileSizeLimit: (path: string, maxBytes: number) =>
    fs.statSync(path).size <= maxBytes,
  // UNC 路径安全检查
  noUncPath: (path: string) => !path.startsWith('\\\\'),
  // 内容不能完全相同（编辑场景）
  contentChanged: (old: string, new_: string) => old !== new_,
}

// ========== 阶段 3：权限校验 ==========

type PermissionBehavior = 'allow' | 'ask' | 'deny' | 'passthrough'

interface PermissionResult {
  behavior: PermissionBehavior
  message?: string
  updatedInput?: unknown              // 可修改输入
  suggestions?: PermissionSuggestion[]  // "Yes, and don't ask again" 建议
}

interface PermissionSuggestion {
  type: 'addRules'
  destination: 'localSettings' | 'userSettings' | 'projectSettings'
  rules: Array<{ toolName: string; ruleContent?: string }>
  behavior: 'allow' | 'deny'
}

async function checkPermissions(
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<PermissionResult> {
  // 工具自身的权限检查
  const toolResult = await tool.checkPermissions(input, context)

  if (toolResult.behavior !== 'passthrough') {
    return toolResult
  }

  // 全局权限系统检查
  return canUseTool(tool, input, context)
}

// ========== 完整流水线 ==========

async function executeToolWithValidation(
  tool: Tool,
  rawInput: unknown,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResultMessage> {
  // 阶段 1
  const structural = validateStructure(tool, rawInput)
  if (!structural.success) return structural.error

  // 阶段 2
  const business = await validateBusiness(tool, structural.data, context)
  if (!business.valid) return business.error

  // 阶段 3
  const permission = await checkPermissions(tool, structural.data, context, canUseTool)
  const finalInput = permission.updatedInput ?? structural.data

  switch (permission.behavior) {
    case 'allow':
      return tool.call(finalInput, context)
    case 'deny':
      return { type: 'tool_result', content: permission.message!, is_error: true }
    case 'ask':
      // 进入用户审批流程（见 human/decision-matrix.ts）
      return requestUserApproval(tool, finalInput, permission)
    case 'passthrough':
      return tool.call(finalInput, context)
  }
}
