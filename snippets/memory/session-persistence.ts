/**
 * 会话持久化 — JSONL 格式 + 恢复优化
 *
 * 模式：JSONL 追加 + compact_boundary 标记 + 大文件优化加载
 * 关键点：
 * - 每行一个 JSON 条目，支持增量读取
 * - Entry 使用联合类型，新类型追加不影响旧类型
 * - 文件 > 5MB 时用 boundary 标记优化加载
 * - 转录写入为 fire-and-forget（不阻塞主循环）
 */

// ========== Entry 类型联合 ==========

type TranscriptEntry =
  | TranscriptMessage          // 用户/助手/附件/系统消息
  | SummaryMessage             // 会话摘要
  | CustomTitleMessage         // 用户设置的标题
  | AiTitleMessage             // AI 生成的标题
  | FileHistorySnapshot        // 文件备份快照
  | ContextCollapseCommit      // 归档消息范围
  | WorktreeStateEntry         // Worktree 会话持久化

interface TranscriptMessage {
  type: 'user' | 'assistant' | 'attachment' | 'system'
  uuid: string
  parentUuid: string | null       // 链父级
  isSidechain: boolean            // 子代理侧链
  timestamp: number
  content: unknown
  // 可选元数据
  gitBranch?: string
  agentId?: string                // 子代理侧链恢复
}

// ========== 类型守卫 ==========

function isTranscriptMessage(entry: TranscriptEntry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

// ========== JSONL 读写 ==========

async function appendToTranscript(
  sessionPath: string,
  entry: TranscriptEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + '\n'
  await fs.appendFile(sessionPath, line, 'utf-8')
}

// Fire-and-forget 写入（不阻塞主循环）
function recordTranscriptAsync(
  sessionPath: string,
  entry: TranscriptEntry,
): void {
  appendToTranscript(sessionPath, entry).catch(err =>
    console.error(`Failed to record transcript: ${err}`)
  )
}

// ========== 会话恢复（大文件优化） ==========

const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024  // 5MB

async function loadTranscript(
  sessionPath: string,
): Promise<TranscriptEntry[]> {
  const stat = await fs.stat(sessionPath)

  if (stat.size > SKIP_PRECOMPACT_THRESHOLD) {
    // 大文件：搜索 compact_boundary，只加载边界之后
    return loadFromBoundary(sessionPath)
  }

  // 小文件：全量加载
  return loadFullTranscript(sessionPath)
}

async function loadFromBoundary(
  sessionPath: string,
): Promise<TranscriptEntry[]> {
  const content = await fs.readFile(sessionPath, 'utf-8')
  const boundaryMarker = '"compact_boundary"'

  // 从末尾向前搜索边界
  const boundaryIndex = content.lastIndexOf(boundaryMarker)

  if (boundaryIndex === -1) {
    return loadFullTranscript(sessionPath)  // 无边界，全量加载
  }

  // 找到边界所在行的起始位置
  const lineStart = content.lastIndexOf('\n', boundaryIndex) + 1
  const postBoundary = content.slice(lineStart)

  return postBoundary
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

async function loadFullTranscript(
  sessionPath: string,
): Promise<TranscriptEntry[]> {
  const content = await fs.readFile(sessionPath, 'utf-8')
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}
