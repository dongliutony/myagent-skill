/**
 * 工具接口定义 + 构建器（fail-closed 默认值）
 *
 * 模式：泛型接口 + 构建器函数填充安全默认值
 * 关键点：
 * - 三层方法：分类（安全性）、验证（输入）、执行（调用）
 * - 构建器默认 fail-closed：不并发、不只读、不破坏
 * - UI 方法：活动描述、摘要、渲染
 */

import { z } from 'zod'

// ========== 核心接口 ==========

interface Tool<
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  Progress = unknown,
> {
  name: string
  aliases?: string[]                     // 旧名称向后兼容
  inputSchema: Input
  inputJSONSchema?: JSONSchema           // 替代方案（MCP 工具用 JSON Schema）
  outputSchema?: z.ZodType<Output>
  maxResultSizeChars: number             // 超出后持久化到磁盘

  // ---- 分类方法 ----
  isEnabled(): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean   // 可与其他工具并行？
  isReadOnly(input: z.infer<Input>): boolean           // 不修改状态？
  isDestructive(input: z.infer<Input>): boolean        // 删除/覆盖？
  isOpenWorld(input: z.infer<Input>): boolean           // 访问全局资源？

  // ---- 验证与权限 ----
  validateInput(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // ---- 执行 ----
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: Message,
    onProgress?: (progress: Progress) => void,
  ): Promise<ToolCallResult<Output>>

  // ---- UI ----
  description(): string | Promise<string>
  prompt(): string | Promise<string>              // 工具专用 prompt
  userFacingName(input: z.infer<Input>): string
  getActivityDescription(input: z.infer<Input>): string  // Spinner 文字
  getToolUseSummary(input: z.infer<Input>): string       // 紧凑展示

  // ---- 搜索/读取分类（UI 折叠） ----
  isSearchOrReadCommand(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList: boolean
  }
}

// ========== 验证与权限结果类型 ==========

type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode?: number }

type PermissionResult = {
  behavior: 'allow' | 'ask' | 'deny' | 'passthrough'
  message?: string
  updatedInput?: unknown             // 可修改输入
  suggestions?: PermissionSuggestion[]  // 规则建议
}

// ========== 构建器（安全默认值） ==========

type ToolDefaults = Pick<Tool,
  | 'isEnabled' | 'isConcurrencySafe' | 'isReadOnly'
  | 'isDestructive' | 'isOpenWorld' | 'checkPermissions'
  | 'userFacingName'
>

const TOOL_DEFAULTS: ToolDefaults = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,   // 默认不允许并发（fail-closed）
  isReadOnly: () => false,           // 默认假设有写入
  isDestructive: () => false,
  isOpenWorld: () => false,
  checkPermissions: async (_input, _ctx) => ({
    behavior: 'allow' as const,
  }),
  userFacingName: function(this: Tool) { return this.name },
}

function buildTool<D extends Partial<Tool>>(def: D): Tool {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name ?? 'unknown',
    ...def,
  } as Tool
}

// ========== 懒加载 Schema 模式 ==========

function lazySchema<T extends z.ZodType>(factory: () => T): T {
  let cached: T | undefined
  return new Proxy({} as T, {
    get(_, prop) {
      if (!cached) cached = factory()
      return (cached as any)[prop]
    },
  })
}

// 用法示例：
const fileReadInputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }),
)
