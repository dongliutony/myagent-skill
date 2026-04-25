/**
 * 推测执行 — Copy-on-Write Overlay + 流水线
 *
 * 模式：overlay 文件系统 + 工具边界 + 流水线建议
 * 关键点：
 * - 写入操作到 overlay（用户拒绝可丢弃）
 * - 只读工具允许，需权限的工具在边界中止
 * - 推测完成后立即生成下一个建议（流水线）
 * - overlay 安全清理（3 次重试）
 */

type SpeculationBoundary = 'complete' | 'bash' | 'edit' | 'denied_tool'

interface SpeculationState {
  status: 'idle' | 'active'
  overlayPath?: string
  writtenPaths?: Set<string>
  boundary?: SpeculationBoundary
  toolUseCount?: number
  pipelinedSuggestion?: string
}

// ========== Overlay 文件系统 ==========

async function createOverlay(speculationId: string): Promise<string> {
  const overlayPath = path.join(os.tmpdir(), 'agent-speculation', speculationId)
  await fs.mkdir(overlayPath, { recursive: true })
  return overlayPath
}

function safeRemoveOverlay(overlayPath: string): void {
  fs.rm(overlayPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  }).catch(() => {})  // 静默失败
}

// ========== 工具边界判断 ==========

function canExecuteInSpeculation(
  tool: Tool,
  input: unknown,
): 'allow' | 'allow_overlay' | 'boundary' {
  // 只读工具 — 直接允许
  if (tool.isReadOnly(input)) return 'allow'

  // 搜索类工具
  const searchRead = tool.isSearchOrReadCommand(input)
  if (searchRead.isSearch || searchRead.isRead || searchRead.isList) return 'allow'

  // 写入工具（Edit, Write）— 写到 overlay
  if (isFileWriteTool(tool)) return 'allow_overlay'

  // Bash — 只读命令允许
  if (tool.name === 'bash' && isBashReadOnly(input)) return 'allow'

  // 需要权限 / 其他 — 在边界中止
  return 'boundary'
}

// ========== 推测执行引擎 ==========

async function runSpeculation(
  messages: Message[],
  context: ToolUseContext,
): Promise<SpeculationState> {
  const id = crypto.randomUUID()
  const overlayPath = await createOverlay(id)
  const writtenPaths = new Set<string>()
  let boundary: SpeculationBoundary | undefined
  let toolUseCount = 0

  try {
    // 运行查询循环（使用 overlay CWD）
    for await (const event of queryLoop({
      ...context,
      overlayPath,
      onToolUse: (tool, input) => {
        const decision = canExecuteInSpeculation(tool, input)
        if (decision === 'boundary') {
          boundary = tool.name === 'bash' ? 'bash'
            : tool.name === 'edit' ? 'edit'
            : 'denied_tool'
          return false  // 中止
        }
        if (decision === 'allow_overlay') {
          writtenPaths.add(getFilePath(input))
        }
        toolUseCount++
        return true  // 继续
      },
    })) {
      // 收集推测结果
    }

    boundary = boundary ?? 'complete'
  } catch {
    boundary = 'denied_tool'
  }

  return {
    status: 'active',
    overlayPath,
    writtenPaths,
    boundary,
    toolUseCount,
  }
}

// ========== 用户接受/拒绝 ==========

async function acceptSpeculation(
  state: SpeculationState,
  messages: Message[],
): Promise<void> {
  // 将 overlay 中的文件复制到真实文件系统
  for (const filePath of state.writtenPaths ?? []) {
    const overlayFile = path.join(state.overlayPath!, filePath)
    await fs.copyFile(overlayFile, filePath)
  }

  // 注入推测消息到对话
  messages.push(...speculatedMessages)

  // 清理 overlay
  safeRemoveOverlay(state.overlayPath!)
}

function rejectSpeculation(state: SpeculationState): void {
  // 丢弃 overlay，什么都不做
  safeRemoveOverlay(state.overlayPath!)
}

// ========== 流水线推测 ==========

// 推测完成后，立即用推测结果生成下一个建议
async function generatePipelinedSuggestion(
  speculatedMessages: Message[],
  parentAbortController: AbortController,
): Promise<string | null> {
  const childController = createChildAbortController(parentAbortController)

  try {
    let suggestion = ''
    for await (const event of queryLoop({
      messages: speculatedMessages,
      abortController: childController,
    })) {
      if (event.type === 'text') suggestion += event.text
    }
    return suggestion
  } catch {
    return null
  }
}
