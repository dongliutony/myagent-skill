/**
 * 确定性 8 层 Agent 清理
 *
 * 模式：finally 块中的分层清理 + 错误不传播
 * 关键点：
 * - 每层独立 try-catch（一层失败不影响其他层）
 * - 清理顺序：外部资源 → 内部状态 → 遥测
 * - 内存显式释放（clear + length = 0）
 * - 后台任务终止
 */

async function runAgentWithCleanup(
  agentId: string,
  agentDefinition: AgentDefinition,
  context: ToolUseContext,
  initialMessages: Message[],
): Promise<AgentResult> {
  let mcpCleanup: (() => Promise<void>) | null = null

  try {
    // 初始化 Agent 特有的 MCP 服务器
    if (agentDefinition.mcpServers) {
      mcpCleanup = await initializeAgentMcpServers(
        agentDefinition.mcpServers,
        agentId,
      )
    }

    // 运行 Agent 主循环
    return await executeAgentLoop(agentDefinition, context, initialMessages)
  } finally {
    // ========== 8 层确定性清理 ==========

    // 层 1：MCP 服务器清理（外部连接）
    try {
      if (mcpCleanup) await mcpCleanup()
    } catch (err) {
      logDebug(`MCP cleanup failed for ${agentId}: ${err}`)
    }

    // 层 2：Session Hook 清理
    try {
      if (agentDefinition.hooks) {
        clearSessionHooks(agentId)
      }
    } catch (err) {
      logDebug(`Hook cleanup failed for ${agentId}: ${err}`)
    }

    // 层 3：Prompt Cache 追踪清理
    try {
      cleanupCacheTracking(agentId)
    } catch (err) {
      logDebug(`Cache tracking cleanup failed for ${agentId}: ${err}`)
    }

    // 层 4：内存释放
    try {
      context.readFileState.clear()
      initialMessages.length = 0  // 释放消息数组引用
    } catch (err) {
      logDebug(`Memory cleanup failed for ${agentId}: ${err}`)
    }

    // 层 5：遥测清理
    try {
      unregisterPerfettoAgent(agentId)
      clearAgentTranscriptSubdir(agentId)
    } catch (err) {
      logDebug(`Telemetry cleanup failed for ${agentId}: ${err}`)
    }

    // 层 6：AppState 清理（移除孤儿条目）
    try {
      setAppState(prev => {
        if (!(agentId in prev.todos)) return prev
        const { [agentId]: _removed, ...todos } = prev.todos
        return { ...prev, todos }
      })
    } catch (err) {
      logDebug(`AppState cleanup failed for ${agentId}: ${err}`)
    }

    // 层 7：后台 Shell 任务终止
    try {
      killShellTasksForAgent(agentId)
    } catch (err) {
      logDebug(`Shell task cleanup failed for ${agentId}: ${err}`)
    }

    // 层 8：Monitor 任务清理
    try {
      killMonitorTasksForAgent(agentId)
    } catch (err) {
      logDebug(`Monitor task cleanup failed for ${agentId}: ${err}`)
    }
  }
}

// ========== Worktree 清理 ==========

async function cleanupWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  action: 'keep' | 'remove' = 'remove',
  discardChanges: boolean = false,
): Promise<void> {
  if (action === 'keep') return  // 保留供后续恢复

  try {
    if (discardChanges) {
      await exec(`git -C ${worktreePath} checkout -- .`)
    }
    await exec(`git worktree remove ${worktreePath} --force`)
    if (worktreeBranch) {
      await exec(`git branch -D ${worktreeBranch}`)
    }
  } catch (err) {
    logDebug(`Worktree cleanup failed: ${err}`)
  }
}

// ========== Worktree 隔离创建 ==========

function validateWorktreeSlug(slug: string): void {
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('Invalid worktree slug: path traversal detected')
  }
  if (slug.length > 64) {
    throw new Error('Worktree slug too long (max 64 chars)')
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    throw new Error('Invalid characters in worktree slug')
  }
}

async function createWorktreeForAgent(
  repoRoot: string,
  slug: string,
): Promise<{ worktreePath: string; branch: string }> {
  validateWorktreeSlug(slug)

  const worktreePath = path.join(repoRoot, '..', `.worktrees/${slug}`)
  const branch = `agent/${slug}`

  await exec(`git worktree add -b ${branch} ${worktreePath}`)

  // 符号链接大目录避免磁盘膨胀
  const dirsToSymlink = ['node_modules', '.venv', 'vendor']
  for (const dir of dirsToSymlink) {
    const source = path.join(repoRoot, dir)
    const target = path.join(worktreePath, dir)
    if (await exists(source)) {
      await fs.symlink(source, target)
    }
  }

  return { worktreePath, branch }
}
