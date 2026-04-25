/**
 * 三层工具注册表
 *
 * 模式：全量加载 → 权限过滤 → 合并去重
 * 关键点：
 * - 内置工具优先于 MCP 工具
 * - 排序固定保证 Prompt Cache 稳定
 * - Deny 规则在展示时就过滤，不等到调用时
 * - Feature Flag 控制工具可用性
 */

type Tool = { name: string; isMcp?: boolean; isEnabled(): boolean }

// ========== 层 1：全量工具列表 ==========

function getAllBaseTools(): Tool[] {
  const tools: Tool[] = [
    // 核心工具（始终存在）
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,

    // 条件工具（Feature Flag 控制）
    ...(featureEnabled('GLOB_TOOL') ? [GlobTool, GrepTool] : []),
    ...(featureEnabled('AGENT_TOOL') ? [AgentTool] : []),
    ...(featureEnabled('WEB_TOOLS') ? [WebFetchTool, WebSearchTool] : []),
    ...(featureEnabled('CRON') ? [ScheduleCronTool] : []),
  ]

  return tools
}

// ========== 层 2：按权限上下文过滤 ==========

function getTools(permissionContext: ToolPermissionContext): Tool[] {
  let tools = getAllBaseTools()

  // 受限模式只保留基础工具
  if (permissionContext.mode === 'simple') {
    tools = tools.filter(t => SIMPLE_MODE_TOOLS.has(t.name))
  }

  // 移除未启用的工具
  tools = tools.filter(t => t.isEnabled())

  // 移除被 blanket deny 的工具
  tools = filterToolsByDenyRules(tools, permissionContext)

  return tools
}

function filterToolsByDenyRules(
  tools: Tool[],
  ctx: ToolPermissionContext,
): Tool[] {
  return tools.filter(tool => {
    // 如果有 blanket deny 规则（toolName 无 ruleContent），则移除
    const blanketDeny = ctx.alwaysDenyRules.some(
      rule => rule.toolName === tool.name && !rule.ruleContent
    )
    return !blanketDeny
  })
}

// ========== 层 3：合并内置 + MCP ==========

function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tool[],
): Tool[] {
  const builtInTools = getTools(permissionContext)

  // 合并，内置优先（去重）
  const seen = new Set<string>()
  const merged: Tool[] = []

  // 内置工具作为连续前缀（Prompt Cache 稳定）
  for (const tool of builtInTools) {
    seen.add(tool.name)
    merged.push(tool)
  }

  // MCP 工具追加
  for (const tool of mcpTools) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name)
      merged.push(tool)
    }
  }

  return merged
}

// ========== MCP 工具包装器 ==========

function wrapMcpTool(serverName: string, mcpTool: McpToolDef): Tool {
  return buildTool({
    name: `mcp__${serverName}__${mcpTool.name}`,
    isMcp: true,
    inputSchema: z.object({}).passthrough(),  // 透传 schema
    inputJSONSchema: mcpTool.inputSchema,      // MCP 定义的 JSON Schema

    isDestructive: () => mcpTool.annotations?.destructiveHint ?? false,
    isOpenWorld: () => mcpTool.annotations?.openWorldHint ?? false,

    checkPermissions: async () => ({
      behavior: 'passthrough' as const,
      message: 'MCP tool requires permission.',
    }),

    call: async (input, context) => {
      return mcpClient.callTool(serverName, mcpTool.name, input)
    },
  })
}
