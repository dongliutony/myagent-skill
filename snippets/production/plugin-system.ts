/**
 * 插件架构 — Manifest 验证 + 三层发现 + 热重载
 *
 * 模式：类型化 Manifest + 多组件贡献 + 原子性重载
 * 关键点：
 * - 插件可贡献：命令、Agent、Skill、Hook、MCP、LSP
 * - Manifest Zod 验证（宽松顶层 + 严格嵌套）
 * - 三层发现：Marketplace + Session + 内联
 * - 热重载：clear-then-register 原子性
 */

// ========== 插件类型 ==========

interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  path: string
  source: string              // 'github:owner/repo', 'local', 'builtin'
  enabled: boolean
  isBuiltin: boolean

  // 组件路径
  commandsPath?: string
  agentsPath?: string
  skillsPath?: string
  outputStylesPath?: string

  // 配置
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
}

// ========== Manifest 验证 ==========

const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),

  // 组件声明
  commands: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.union([z.string(), HooksSchema]).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  lspServers: z.record(LspServerConfigSchema).optional(),
}).passthrough()  // 宽松顶层：未知字段静默忽略（前向兼容）

// ========== 三层发现 ==========

async function discoverPlugins(settings: Settings): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = []

  // 层 1：Marketplace 插件
  for (const [pluginId, config] of Object.entries(settings.plugins ?? {})) {
    if (config.enabled) {
      const plugin = await loadMarketplacePlugin(pluginId)
      if (plugin) plugins.push(plugin)
    }
  }

  // 层 2：Session 插件（CLI --plugin-dir）
  for (const dir of getSessionPluginDirs()) {
    const plugin = await loadPluginFromDir(dir, 'session')
    if (plugin) plugins.push(plugin)
  }

  // 层 3：内联插件（SDK --plugin）
  for (const inline of getInlinePlugins()) {
    plugins.push(inline)
  }

  // 层 0：内置插件
  plugins.push(...getBuiltinPlugins())

  return plugins
}

// ========== 插件目录结构 ==========

/*
my-plugin/
├── plugin.json           # Manifest（Zod 验证）
├── commands/             # 斜杠命令（*.md）
├── agents/               # Agent 定义（*.md with frontmatter）
├── skills/               # Skill 目录（skill-name/SKILL.md）
├── hooks/hooks.json      # Hook 配置
├── .mcp.json             # MCP 服务器
├── .lsp.json             # LSP 服务器
└── output-styles/        # 输出风格
*/

// ========== 热重载（原子性） ==========

async function refreshActivePlugins(setAppState: SetAppState): Promise<void> {
  // 1. 清除所有缓存
  clearAllMemoizedCaches()

  // 2. 从磁盘重新加载
  const plugins = await discoverPlugins(getSettings())
  const enabled = plugins.filter(p => p.enabled)
  const disabled = plugins.filter(p => !p.enabled)

  // 3. 并行预热连接
  await Promise.all([
    warmMcpConnections(enabled),
    warmLspConnections(enabled),
  ])

  // 4. 原子更新 AppState
  setAppState(prev => ({
    ...prev,
    plugins: { enabled, disabled, commands: collectCommands(enabled) },
    mcp: {
      ...prev.mcp,
      pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,  // 触发 MCP 重连
    },
  }))

  // 5. 原子重注册 Hooks
  const allHooks = collectHooks(enabled)
  registerHooks(allHooks)  // clear-then-register（见 hook-system.ts）

  // 6. LSP 重初始化
  reinitializeLspServerManager()
}

// ========== 条件 Skill 激活 ==========

const conditionalSkills = new Map<string, SkillDefinition>()
const activatedSkillNames = new Set<string>()

function activateConditionalSkills(touchedFilePaths: string[]): void {
  for (const [name, skill] of conditionalSkills) {
    if (activatedSkillNames.has(name)) continue

    // 检查 paths: frontmatter 匹配
    if (skill.paths && matchesGitignorePattern(touchedFilePaths, skill.paths)) {
      activatedSkillNames.add(name)
      // 加载并注册 skill
      dynamicSkills.set(name, skill)
      emitSignal('skillsLoaded')
    }
  }
}
