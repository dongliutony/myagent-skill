/**
 * 文件信箱协议 — lockfile 保护的 Agent 间通信
 *
 * 模式：JSON 文件队列 + lockfile 并发控制 + 结构化协议消息
 * 关键点：
 * - lockfile 保护并发写入（10 次重试，5-100ms 退避）
 * - 结构化协议消息从 LLM 上下文中分离
 * - 支持权限请求/审批/关闭等生命周期消息
 */

import lockfile from 'proper-lockfile'

// ========== 信箱路径 ==========

function getMailboxPath(agentName: string, teamName: string): string {
  return path.join(
    os.homedir(), '.agent', 'teams', teamName, 'inboxes', `${agentName}.json`
  )
}

// ========== 消息类型 ==========

interface BaseMessage {
  id: string
  from: string
  timestamp: number
  read: boolean
}

type AgentMessage =
  | PlainTextMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | ShutdownRequestMessage
  | ShutdownResponseMessage
  | PlanApprovalRequestMessage
  | PlanApprovalResponseMessage
  | TaskAssignmentMessage
  | IdleNotificationMessage

interface PlainTextMessage extends BaseMessage {
  type: 'plain_text'
  content: string
}

interface PermissionRequestMessage extends BaseMessage {
  type: 'permission_request'
  toolName: string
  toolInput: unknown
  requestId: string
}

interface PermissionResponseMessage extends BaseMessage {
  type: 'permission_response'
  requestId: string
  decision: 'approve' | 'deny'
  feedback?: string
}

interface ShutdownRequestMessage extends BaseMessage {
  type: 'shutdown_request'
  reason: string
}

interface ShutdownResponseMessage extends BaseMessage {
  type: 'shutdown_approved' | 'shutdown_rejected'
}

// ========== 结构化消息路由 ==========

function isStructuredProtocolMessage(msg: AgentMessage): boolean {
  // 协议消息不进入 LLM 上下文
  return msg.type !== 'plain_text'
}

// ========== 信箱读写（lockfile 保护） ==========

const LOCK_OPTIONS = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
}

async function readMailbox(
  agentName: string,
  teamName: string,
): Promise<AgentMessage[]> {
  const mailboxPath = getMailboxPath(agentName, teamName)

  try {
    const content = await fs.readFile(mailboxPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return []  // 文件不存在 = 空信箱
  }
}

async function writeToMailbox(
  recipientName: string,
  message: Omit<AgentMessage, 'read'>,
  teamName: string,
): Promise<void> {
  const mailboxPath = getMailboxPath(recipientName, teamName)
  const lockFilePath = mailboxPath + '.lock'

  // 确保目录存在
  await fs.mkdir(path.dirname(mailboxPath), { recursive: true })

  // 获取锁
  const release = await lockfile.lock(mailboxPath, {
    lockfilePath: lockFilePath,
    ...LOCK_OPTIONS,
  })

  try {
    // 锁定后重新读取（获取最新状态）
    const messages = await readMailbox(recipientName, teamName)
    messages.push({ ...message, read: false })
    await fs.writeFile(mailboxPath, JSON.stringify(messages, null, 2), 'utf-8')
  } finally {
    await release()
  }
}

// ========== 权限请求通过信箱 ==========

const PERMISSION_POLL_INTERVAL_MS = 500

async function requestPermissionViaMailbox(
  leaderName: string,
  teamName: string,
  toolName: string,
  toolInput: unknown,
): Promise<'approve' | 'deny'> {
  const requestId = crypto.randomUUID()

  // 发送请求
  await writeToMailbox(leaderName, {
    id: crypto.randomUUID(),
    from: getCurrentAgentContext()!.agentName,
    timestamp: Date.now(),
    type: 'permission_request',
    toolName,
    toolInput,
    requestId,
  }, teamName)

  // 轮询等待响应
  while (true) {
    await sleep(PERMISSION_POLL_INTERVAL_MS)
    const messages = await readMailbox(
      getCurrentAgentContext()!.agentName,
      teamName,
    )
    const response = messages.find(
      m => m.type === 'permission_response' && m.requestId === requestId
    ) as PermissionResponseMessage | undefined

    if (response) return response.decision
  }
}
