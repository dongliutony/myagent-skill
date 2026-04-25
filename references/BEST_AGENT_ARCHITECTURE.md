# 生产级 AI Agent 架构深度解析 — 18 项关键技术的工程实现

> 本文档提炼自业界最佳实践 Agent 产品的源码分析，覆盖从核心循环到产品化的完整技术栈。
> 所有模式均经过生产环境验证，适用于构建任何 LLM 驱动的 Agent 系统。

---

## 目录

- [第一部分：核心引擎](#第一部分核心引擎)
  - [1. Agent 循环](#1-agent-循环)
  - [2. 工具系统](#2-工具系统)
  - [3. Prompt 管线](#3-prompt-管线)
  - [4. 记忆与会话](#4-记忆与会话)
- [第二部分：安全与控制](#第二部分安全与控制)
  - [5. 权限与安全](#5-权限与安全)
  - [6. Human-in-the-Loop](#6-human-in-the-loop)
- [第三部分：可靠性与性能](#第三部分可靠性与性能)
  - [7. 错误恢复与韧性](#7-错误恢复与韧性)
  - [8. 流式与性能优化](#8-流式与性能优化)
- [第四部分：运营](#第四部分运营)
  - [9. 可观测性](#9-可观测性)
  - [10. 成本控制](#10-成本控制)
- [第五部分：规模化](#第五部分规模化)
  - [11. 多 Agent 编排](#11-多-agent-编排)
  - [12. 产品化工程](#12-产品化工程)
  - [13. CLI / UX 设计](#13-cli--ux-设计)
- [附录](#附录)
  - [A. 状态机设计](#a-状态机设计)
  - [B. 模型无关架构](#b-模型无关架构)
  - [C. 版本兼容策略](#c-版本兼容策略)
  - [D. 文件系统与 Workspace](#d-文件系统与-workspace)
  - [E. 用户信任机制](#e-用户信任机制)

---

# 第一部分：核心引擎

## 1. Agent 循环

### 1.1 循环结构

生产级 Agent 的核心是一个 `while(true)` 无限循环的 AsyncGenerator，通过明确的终止条件和状态转换控制生命周期。

**核心状态**：

```typescript
type LoopState = {
  messages: Message[]                         // 对话历史
  turnCount: number                           // 轮次计数（从 1 起）
  maxOutputTokensRecoveryCount: number        // 输出 token 恢复尝试次数
  hasAttemptedReactiveCompact: boolean        // 防止压缩螺旋守卫
  maxOutputTokensOverride: number | undefined // 输出 token 升级覆盖
  transition: ContinueReason | undefined      // 上一轮继续原因
  stopHookActive: boolean | undefined         // 停止 Hook 激活状态
}
```

### 1.2 轮次限制（Step Limit）

**硬限制 — maxTurns**：

```typescript
if (maxTurns && nextTurnCount > maxTurns) {
  yield { type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount }
  return { reason: 'max_turns' }
}
```

- 每轮结束时检查；工具执行中断时也检查
- 通过参数注入，SDK 和 CLI 共用同一套逻辑

**软限制 — Token Budget**：

```typescript
type BudgetTracker = {
  continuationCount: number       // 连续继续次数
  lastDeltaTokens: number         // 上次 token 增量
  startedAt: number               // 起始时间
}
// 停止条件：使用 ≥ 90% 预算 或 收益递减（3+ 次继续，每次 < 500 token）
```

### 1.3 重试策略（Max Retries）

**API 层 — 指数退避 + 抖动**：

| 参数 | 值 | 说明 |
|------|----|------|
| `DEFAULT_MAX_RETRIES` | 10 | 默认最大重试 |
| `MAX_529_RETRIES` | 3 | 连续过载错误上限 |
| `BASE_DELAY_MS` | 500 | 退避基数 |
| 退避公式 | `500 * 2^(n-1)` | 上限 32 秒，±25% 抖动 |

**输出 Token 恢复 — 多轮递进**：

```
第一次命中 → 升级 8k → 64k（单次升级）
后续命中 → 注入 "继续" 消息（最多 3 次）
成功的下一轮 → 重置计数器
```

**持久模式（无人值守）**：

- 通过环境变量 `UNATTENDED_RETRY` 启用
- 无限重试 + 每 30 秒心跳 + 最大退避 5 分钟 + 总上限 6 小时
- 尊重限流重置时间戳

### 1.4 中断处理（Interruption Handling）

**用户中止信号传播**：

```
AbortController.signal
  ├─ 传递到 API 请求 → 取消 HTTP 流
  ├─ 传递到 StreamingToolExecutor → 取消排队工具
  └─ 传递到子进程 → SIGTERM
```

**每个工具声明中断行为**：

```typescript
interruptBehavior(): 'cancel' | 'block'
// cancel → 立即取消，生成合成错误
// block → 等待完成
```

**中止原因判定**：

| 原因 | 含义 |
|------|------|
| `streaming_fallback` | 模型重试回退 |
| `sibling_error` | Bash 错误级联到并行兄弟 |
| `user_interrupted` | 用户主动中止 |

### 1.5 模型回退（Fallback Logic）

```
连续 3 次 529 过载
  ↓ 触发 FallbackTriggeredError
清除助手消息 + 工具结果
  ↓
切换到 fallback model
  ↓
创建新的 StreamingToolExecutor
  ↓
剥离 thinking signatures（兼容性）
  ↓
重试请求
```

### 1.6 部分完成恢复（Partial Completion）

**Prompt Too Long 两阶段恢复**：

```
阶段 1：Context Collapse 排空 → 轻量恢复，保留细粒度上下文
  ↓ 如果失败
阶段 2：Reactive Compact → 全量 LLM 摘要
  ↓ hasAttemptedReactiveCompact 防螺旋
兜底：返回错误
```

**流式回退恢复**：
- 生成 tombstone 消息移除 UI 孤儿
- 清除状态后重试

### 1.7 终止状态全集

| 状态 | 触发条件 | 可恢复 |
|------|----------|--------|
| `completed` | 模型正常结束 | — |
| `max_turns` | 轮次超限 | 否 |
| `aborted_streaming` | 用户中止（流式中） | 否 |
| `aborted_tools` | 用户中止（工具执行中） | 否 |
| `prompt_too_long` | 恢复失败 | 否 |
| `model_error` | 未捕获 API 异常 | 否 |
| `blocking_limit` | 硬上下文限制 | 否（需手动压缩） |
| `stop_hook_prevented` | Stop Hook 阻止 | 否 |
| `hook_stopped` | Hook 停止信号 | 否 |
| `image_error` | 图片大小/格式错误 | 否 |

**继续转换全集**：

| 转换 | 含义 |
|------|------|
| `next_turn` | 正常工具执行后继续 |
| `collapse_drain_retry` | Context Collapse 排空后重试 |
| `reactive_compact_retry` | 全量摘要后重试 |
| `max_output_tokens_escalate` | 输出 token 升级后重试 |
| `max_output_tokens_recovery` | 多轮恢复（≤3 次） |
| `stop_hook_blocking` | 注入 Hook 错误后重试 |
| `token_budget_continuation` | 注入预算提醒后继续 |

---

## 2. 工具系统

### 2.1 工具接口定义

```typescript
Tool<Input, Output, Progress> = {
  name: string
  aliases?: string[]                    // 旧名称向后兼容
  inputSchema: ZodType<Input>           // Zod 验证 schema
  inputJSONSchema?: JSONSchema          // 替代方案（MCP 工具）
  outputSchema?: ZodType<Output>        // 输出类型
  maxResultSizeChars: number            // 超出后持久化到磁盘

  // 分类方法
  isConcurrencySafe(input): boolean     // 默认 false（fail-closed）
  isReadOnly(input): boolean            // 默认 false
  isDestructive(input): boolean         // 默认 false
  isOpenWorld(input): boolean           // 全局资源访问

  // 执行方法
  validateInput(input, ctx): ValidationResult
  checkPermissions(input, ctx): PermissionResult
  call(args, ctx, canUseTool, parent, onProgress): ToolResult

  // UI 方法
  getActivityDescription(input): string   // "Reading src/foo.ts"
  getToolUseSummary(input): string        // 紧凑展示
  renderToolUseMessage(input, opts): JSX
  renderToolResultMessage(output, opts): JSX
}
```

### 2.2 三层工具注册表

```
getAllBaseTools()            → 全量列表（尊重 feature flags）
    ↓
getTools(permissionCtx)     → 按权限过滤（受限模式只保留基础工具）
    ↓
assembleToolPool(ctx, mcp)  → 合并内置 + MCP，去重排序
```

**关键设计**：
- 内置工具优先级高于 MCP 工具（`uniqBy` 去重）
- 排序保证 prompt cache 稳定性
- Deny 规则在 schema 展示时就过滤，不等到调用时

### 2.3 三阶段验证流水线

```
输入解析 → tool.inputSchema.safeParse()     [Zod 结构验证]
    ↓
业务校验 → tool.validateInput()              [路径存在、大小限制、安全检查]
    ↓ 返回 { result: true } 或 { result: false, message, errorCode }
权限校验 → tool.checkPermissions()           [规则匹配、用户审批]
    ↓ 返回 { behavior: 'allow'|'ask'|'deny'|'passthrough' }
执行    → tool.call()
```

### 2.4 并发执行编排

**StreamingToolExecutor 分区策略**：

```typescript
// 工具声明并发安全性
isConcurrencySafe(input): boolean

// 执行器分区逻辑
canExecuteTool(isConcurrencySafe):
  当前无工具在执行 → 允许
  当前有工具 && 新工具 concurrency-safe && 所有在执行的也是 → 允许
  否则 → 排队等待

// Bash 错误级联
if (tool.name === 'bash' && error) {
  siblingAbortController.abort('sibling_error')  // 取消并行兄弟
}
// 只读工具失败不影响兄弟
```

**进度消息绕过排序**：

```typescript
// 进度消息立即 yield，不等待批次完成
while (tool.pendingProgress.length > 0) {
  yield { message: tool.pendingProgress.shift() }
}
```

### 2.5 工具沙箱

| 机制 | 实现 |
|------|------|
| AST 解析 | Tree-sitter 解析 Bash 命令结构 |
| 子命令限制 | 最多 50 个子命令（防 ReDoS） |
| 设备路径封锁 | `/dev/zero`, `/dev/random`, `/dev/tty` 等 |
| 路径遍历防护 | 拒绝 `..`、glob 元字符、UNC 路径 |
| 文件大小限制 | 读写上限 1 GiB |
| Sandbox 运行时 | 可选沙箱容器隔离 |

### 2.6 MCP 工具集成

```typescript
// 通用包装器 — 透传 schema
MCPTool = {
  isMcp: true,
  inputSchema: z.object({}).passthrough(),   // 接受任意输入
  inputJSONSchema: tool.inputSchema,          // MCP 定义的 JSON Schema
  isDestructive: () => tool.annotations?.destructiveHint ?? false,
  isOpenWorld: () => tool.annotations?.openWorldHint ?? false,
}
// 命名：mcp__server__toolname
```

### 2.7 构建器默认值（fail-closed）

```typescript
buildTool(def) → {
  isConcurrencySafe: () => false,    // 默认不并发
  isReadOnly: () => false,            // 默认有写入
  isDestructive: () => false,         // 默认非破坏
  checkPermissions: () => 'allow',    // 默认允许
  toAutoClassifierInput: () => '',    // 默认跳过分类器
}
```

---

## 3. Prompt 管线

### 3.1 多层组装架构

**优先级层次**（高→低）：

```
1. Override System Prompt  — 循环模式替换一切
2. Coordinator Prompt      — 协调者模式
3. Agent Prompt            — 主线程 Agent 定义
4. Custom System Prompt    — --system-prompt 标志
5. Default System Prompt   — 标准 prompt
6. Append System Prompt    — 始终追加
```

### 3.2 缓存分区策略

```
═══ 静态内容（全局缓存 scope: 'global'）═══
├─ 身份与能力声明
├─ 任务执行准则
├─ 工具使用指导
├─ 操作安全规则
└─ 语气风格约定

═══ __DYNAMIC_BOUNDARY__ ═══

═══ 动态内容（组织缓存 scope: 'org'）═══
├─ 会话指导（可用 skill、agent、工具搜索）
├─ 记忆（从 MEMORY.md 加载）
├─ 环境信息（工作目录、OS、git 状态）
├─ MCP 服务器指令
├─ Token Budget 提示（可选）
└─ 自治模式指令（可选）
```

**Prompt 分区类型**：
- `systemPromptSection()` — 记忆化，缓存直到 `/clear` 或 `/compact`
- `uncachedSystemPromptSection()` — 每轮重算，值变化时破坏缓存

### 3.3 工具 Prompt

每个工具有独立的 `prompt()` 方法，返回该工具的使用指导：

```typescript
// 示例：Shell 工具的 prompt 包含
- Git 安全协议（150+ 行）
- PR 创建工作流
- 危险操作警告
- 用户类型变体（内部 vs 外部）
```

**动态组装**：工具 schema 按会话缓存，防止特性标志冷/热切换破坏缓存

### 3.4 压缩 Prompt（三种变体）

| 变体 | 用途 |
|------|------|
| `BASE_COMPACT` | 全量对话摘要 |
| `PARTIAL_COMPACT` | 仅近期消息（保留早期上下文） |
| `PARTIAL_COMPACT_UP_TO` | 摘要置顶，新消息跟随 |

**所有变体强制**：
- "TEXT ONLY" 指令 + maxTurns:1 约束
- 必须输出 `<analysis>` 草稿 + `<summary>` 最终摘要
- 9 个必须章节（请求意图、技术概念、文件代码、错误修复、排查过程、用户消息、待办、当前工作、下一步）

### 3.5 工具结果清理（MicroCompact）

**可清理的工具结果**：FileRead、Grep、Glob、Bash、WebSearch、WebFetch、FileEdit、FileWrite

**系统 prompt 注入警告**：
> "记下重要信息，原始工具结果可能被清理"

### 3.6 错误恢复 Prompt

```typescript
// 工具失败 → is_error: true
{ type: 'tool_result', tool_use_id: '<id>', content: '错误信息', is_error: true }
// 模型看到 is_error 后自动换种方式重试
// 系统 prompt 指导："被拒绝时调整方式，不要重试相同调用"
```

---

## 4. 记忆与会话

### 4.1 三层压缩策略

| 策略 | 触发 | 机制 | 保留度 |
|------|------|------|--------|
| **AutoCompact** | token ≥ 窗口 - 13k | LLM 摘要调用 | 中（结构化摘要） |
| **Context Collapse** | 逐步归档 | 摘要占位符替换 | 高（细粒度控制） |
| **MicroCompact** | 旧工具结果 | 截断/清理 | 低（只保留近期） |

**阈值配置**：

```typescript
AUTOCOMPACT_BUFFER = 13_000          // 触发自动压缩
WARNING_BUFFER = 20_000               // 警告级
ERROR_BUFFER = 20_000                 // 错误级
MANUAL_COMPACT_BUFFER = 3_000         // 手动 /compact
MAX_CONSECUTIVE_FAILURES = 3          // 断路器
```

**Context Collapse 数据结构**（`marble-origami` 模式）：

```typescript
type CollapseCommit = {
  collapseId: string              // 16 位 ID
  summaryUuid: string             // 摘要占位符
  summaryContent: string          // <collapsed>text</collapsed>
  firstArchivedUuid: string       // 归档范围起止
  lastArchivedUuid: string
}
// 恢复：commits 按序重放，snapshots last-wins
```

### 4.2 四种记忆类型

| 类型 | 范围 | 用途 | 示例 |
|------|------|------|------|
| `user` | 私有 | 角色、偏好、知识水平 | "资深后端，首次接触 React" |
| `feedback` | 私有/团队 | 工作方式纠正+确认 | "集成测试用真实数据库，不 mock" |
| `project` | 团队 | 进行中工作、决策、截止日期 | "3/5 起合并冻结" |
| `reference` | 团队 | 外部系统指针 | "bug 跟踪在 Linear INGEST 项目" |

**存储格式**：

```markdown
---
name: {{名称}}
description: {{一行描述 — 用于相关性判断}}
type: {{user|feedback|project|reference}}
---
{{内容 — feedback/project 类型包含 Why: 和 How to apply: 行}}
```

### 4.3 选择性记忆召回

- 扫描记忆头部（名称、描述、修改时间）
- 使用轻量模型选择最多 5 个相关记忆
- 过滤已展示路径避免重复
- **漂移防护**：记忆是"写入时的声明"，使用前验证当前状态

### 4.4 会话记忆（自动情景提取）

```typescript
SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,   // 10k token 后启动
  minimumTokensBetweenUpdate: 5_000,    // 每 5k token 更新
  toolCallsBetweenUpdates: 3,           // 或每 3 次工具调用
}
// 使用后台分叉子代理提取，等待最多 15 秒
```

### 4.5 会话持久化

**JSONL 格式**：每行一个 JSON 条目，支持增量读取

**Entry 类型联合**：TranscriptMessage、SummaryMessage、FileHistorySnapshot、ContextCollapseCommit、WorktreeState 等

**恢复优化**：
- 文件 > 5MB 时搜索 `compact_boundary` 标记
- 只加载边界之后的消息
- 崩溃截断处理：重排 attribution 快照到末尾

### 4.6 文件历史快照

```typescript
type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}
// 最大 100 快照，v1 = 编辑前快照，更高版本 = 后续编辑
// backupFileName === null → 该版本文件不存在
```

---

# 第二部分：安全与控制

## 5. 权限与安全

### 5.1 七种权限模式

| 模式 | 行为 |
|------|------|
| `default` | 危险操作需确认 |
| `acceptEdits` | 自动接受编辑 |
| `bypassPermissions` | 跳过所有检查 |
| `dontAsk` | 不询问，拒绝需确认的 |
| `plan` | 仅规划，不执行 |
| `auto` | 分类器自动审批 |
| `bubble` | 权限冒泡到父 Agent |

### 5.2 多来源规则引擎

**规则格式**：`toolName` 或 `toolName(ruleContent)`

```typescript
// 示例
"bash(npm test)"           // 允许特定命令
"Edit(/src/**)"            // 允许编辑特定路径
"bash:*"                   // 通配符
```

**来源优先级**：`policySettings` > `userSettings` > `projectSettings` > `localSettings` > `flagSettings` > `cliArg` > `command` > `session`

### 5.3 六阶段权限决策流

```
阶段 1：配置规则匹配 → 命中 allow/deny 规则 → 立即决策
    ↓ 未命中
阶段 2：模式检测 → dontAsk 转 deny; bypass 转 allow; auto 继续
    ↓ auto 模式
阶段 3：acceptEdits 快速路径 → 编辑工具先测试 acceptEdits
    ↓ 不满足
阶段 4：安全白名单 → SAFE_ALLOWLISTED_TOOLS 跳过分类器
    ↓ 不在白名单
阶段 5：异步分类器 → 后台运行 YOLO 分类器
    ↓ 置信度不足
阶段 6：用户交互 → PermissionPrompt UI
```

### 5.4 命令风险评分

**三级风险**：

| 级别 | 颜色 | 数值 | 示例 |
|------|------|------|------|
| LOW | 绿色 | 1 | `ls`, `cat`, `npm test` |
| MEDIUM | 黄色 | 2 | `npm install`, `git commit` |
| HIGH | 红色 | 3 | `rm -rf`, `git push --force` |

**危险命令模式**：

| 分类 | 命令 |
|------|------|
| 代码执行 | `python`, `node`, `npx`, `bash`, `ssh` |
| 危险 Shell | `eval`, `exec`, `env`, `xargs`, `sudo` |
| 网络操作 | `curl`, `wget` |
| 基础设施 | `kubectl`, `aws`, `gcloud` |

### 5.5 文件系统安全

**受保护文件**：`.gitconfig`, `.bashrc`, `.zshrc`, `.profile`, `.mcp.json`

**受保护目录**：`.git`, `.vscode`, `.idea`, `.claude`

**防护**：大小写不敏感标准化 + `..` 遍历检测 + UNC 路径 NTLM 泄露防护

### 5.6 Hook 系统

| Hook | 时机 | 能力 |
|------|------|------|
| `PreToolUse` | 工具执行前 | 审批/阻止/修改输入 |
| `PostToolUse` | 工具执行后 | 修改输出 |
| `PostToolUseFailure` | 工具失败后 | 日志/报告 |
| `PermissionDenied` | 权限被拒 | 通知 |
| `FileChanged` | 文件变更 | 触发动作 |

```typescript
// PreToolUse Hook 返回
{
  permissionDecision: 'approve' | 'block' | undefined,
  permissionDecisionReason: string,
  updatedInput: ModifiedInput,    // 可修改工具输入
  additionalContext: string,
}
```

---

## 6. Human-in-the-Loop

### 6.1 决策矩阵

| 场景 | 行为 |
|------|------|
| 只读操作 | 自动执行 |
| 文件编辑（acceptEdits 模式） | 自动执行 |
| 文件编辑（default 模式） | 展示 diff → 确认 |
| Shell 命令（匹配 allow 规则） | 自动执行 |
| Shell 命令（未知） | 风险评估 → 确认 |
| Shell 命令（匹配 deny 规则） | 自动拒绝 |
| 危险操作 | 高风险标记 → 确认 |
| 分类器高置信度匹配 | 自动审批 + 展示原因 |

### 6.2 渐进信任模型

```
首次执行 → 必须审批
  ↓ 用户选择 "Yes, and don't ask again for X"
生成 PermissionUpdate 规则 → 写入设置
  ↓
后续执行 → 规则匹配 → 自动执行
```

**规则建议生成**：

```typescript
type PermissionUpdate = {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode'
  destination: 'localSettings' | 'userSettings' | 'projectSettings' | 'session'
  rules: [{ toolName: string, ruleContent?: string }]
  behavior: 'allow' | 'deny'
}
```

### 6.3 反馈闭环

**双向反馈收集**：

```typescript
// 接受 + 反馈："告诉 Agent 下一步做什么"
onAllow(updatedInput, permissionUpdates, feedback?: string)

// 拒绝 + 反馈："告诉 Agent 换种方式"
onReject(feedback?: string, contentBlocks?: ContentBlockParam[])
```

- Tab 展开反馈输入模式
- 反馈文本注入到对话上下文
- 分析跟踪反馈交互行为

### 6.4 自适应回退

**拒绝跟踪**：

```typescript
DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续 3 次拒绝 → 回退到交互模式
  maxTotal: 20,        // 总计 20 次拒绝 → 回退
}
```

### 6.5 非阻塞异步分类器

```
展示权限对话框（带 "Attempting to auto-approve..." 微光动画）
  ↓ 同时
后台运行分类器
  ↓
高置信度 → 自动关闭对话框 → 显示 ✔
低置信度 → 保持对话框 → 等待用户
```

**竞态解决**：多个决策源（用户、Hook、分类器、远程桥接）竞争，首个 claim 获胜

```typescript
const { resolve: resolveOnce, claim } = createResolveOnce(resolve)
// 200ms 恩惠期 — 防止启动时误触
if (Date.now() - startTime < GRACE_PERIOD_MS) return
```

### 6.6 Plan 模式审批

```
Agent 进入 plan 模式 → 权限收紧（只读）
  ↓
展示计划
  ↓
plan_approval_request 发送到 leader
  ↓
用户审批 → 退出 plan 模式 → 执行
用户拒绝 → 重新规划
```

### 6.7 决策溯源

每个权限决策携带完整溯源：

```typescript
type DecisionReason =
  | { type: 'rule', rule: PermissionRule }
  | { type: 'mode', mode: PermissionMode }
  | { type: 'hook', hookName: string }
  | { type: 'classifier', classifier: string, reason: string }
  | { type: 'subcommandResults', reasons: Map<string, Result> }
```

---

# 第三部分：可靠性与性能

## 7. 错误恢复与韧性

### 7.1 分层重试策略

| 层 | 错误类型 | 策略 |
|----|----------|------|
| **API** | 429 限流 | 指数退避 + Retry-After |
| **API** | 529 过载 | 计数 → 3 次后模型回退 |
| **API** | 401/403 认证 | Token/OAuth 刷新 |
| **API** | 网络错误 | 禁用 keep-alive → 重试 |
| **上下文** | 413 过长 | 两阶段压缩恢复 |
| **输出** | max_output_tokens | 升级 8k→64k → 3 轮恢复 |
| **媒体** | 图片过大 | Reactive compact 剥离 |
| **Hook** | 阻塞错误 | 注入错误后重试循环 |

### 7.2 上下文溢出恢复

```typescript
// 解析错误消息获取限制
availableContext = contextLimit - inputTokens - 1000
// 调整 maxTokensOverride → 重试相同请求
```

### 7.3 优雅降级全景

| 场景 | 降级行为 |
|------|----------|
| 远程设置获取失败 | 用磁盘缓存 → 跳过 |
| Feature Flag 初始化超时 | 返回默认值 |
| MCP 服务器连接失败 | 跳过该服务器 |
| 插件加载错误 | 不阻塞启动 |
| 模型过载 | 回退到 fallback 模型 |
| 快速模式限流 | 冷却期 → 标准模式 |
| 压缩失败（3 次） | 断路器开启 → 跳过 |

### 7.4 部分成功处理

- **工具并行执行**：只读工具独立失败，不影响兄弟
- **输出恢复**：3 次机会，每次注入 "继续" 消息
- **流式回退**：清理孤儿 → tombstone → 重试
- **Bash 级联**：仅 Bash 错误取消并行兄弟，其他工具独立

---

## 8. 流式与性能优化

### 8.1 全链路 AsyncGenerator 流式

```
LLM API（SSE）
  ↓ 事件流
StreamingToolExecutor（并发分区）
  ↓ yield 进度/结果
queryLoop（AsyncGenerator）
  ↓ yield 事件
QueryEngine.submitMessage（AsyncGenerator）
  ↓ yield SDKMessage
UI 渲染（实时）
```

### 8.2 消息扣留机制

```typescript
// 可恢复错误（413、max-output-tokens）扣留消息
// 推送到 assistantMessages 用于恢复检查
// 仅在不可恢复时才 yield 给 UI
withheldMessages ← 可恢复错误
assistantMessages ← 始终推送（用于恢复逻辑）
UI ← 仅不可恢复或成功消息
```

### 8.3 流式空闲看门狗

```typescript
STREAM_IDLE_TIMEOUT = 90_000ms      // 90 秒无数据 → 中止流
STREAM_IDLE_WARNING = 45_000ms      // 45 秒警告
// 超时后 → 释放资源 → 触发非流式回退
// 非流式超时：远程 120s / 默认 300s
```

### 8.4 推测执行（Speculation）

```
用户输入后 → 推测下一步可能的操作
  ↓
Copy-on-Write Overlay 文件系统
  ↓
允许：只读工具 + 写入工具（到 overlay）
禁止：需要权限的工具 → 在边界处中止
  ↓
用户接受推测 → 注入消息
用户拒绝 → 丢弃 overlay
```

**流水线推测**：推测结果通过另一个查询循环生成下一个建议，用户审查当前时已准备好下一个

### 8.5 Prompt Cache 经济学

| 缓存类型 | TTL | 成本 |
|----------|-----|------|
| 标准 | 5 分钟 | 读取 = 输入成本 10% |
| Beta | 1 小时 | 写入 = 输入成本 25% |

**Cache 稳定性保障**：
- 工具 schema 排序固定（内置前缀 + MCP 后缀）
- Feature flag 值按会话锁定防止冷/热翻转
- Fork 子代理生成字节一致前缀共享 cache
- 系统 prompt 字节通过 override 传递防止求值分歧

**Cache 失效检测**：

```typescript
// 追踪 hash：systemHash, toolsHash, cacheControlHash
// 最小显著下降：MIN_CACHE_MISS_TOKENS = 2000
// 检测：prompt、工具、模型、betas、effort 变化 → 生成 diff 用于调试
```

### 8.6 进度与完成解耦

```typescript
// StreamingToolExecutor 双 Generator
getCompletedResults()    // 同步 — 按顺序 yield 完成的工具结果
getRemainingResults()    // 异步 — 工具完成时 yield

// Progress vs Completion 竞赛
await Promise.race([...executingPromises, progressPromise])
// 进度消息永远立即 yield，不被完成阻塞
```

---

# 第四部分：运营

## 9. 可观测性

### 9.1 双写分析管线

```
事件 → logEvent()
  ├─ 第一方分析 → 内部 API（/api/metrics）
  └─ Datadog → HTTP intake（15 秒批量，最大 100 事件）
```

**数据安全标记**：

```typescript
AnalyticsMetadata_VERIFIED_NOT_CODE_OR_FILEPATHS  // 非代码/路径
AnalyticsMetadata_VERIFIED_PII_TAGGED              // PII 已标记
```

### 9.2 OpenTelemetry 集成

```typescript
// 导出间隔
metrics: 60s
logs: 5s
traces: 5s

// 资源检测
envDetector, hostDetector, osDetector

// 会话追踪
startTelemetryInteractionSpan()  // 包装 API 调用
endInteractionSpan()              // 记录时长/token/错误
```

### 9.3 指标体系

| 指标 | 计数器 | 用途 |
|------|--------|------|
| 会话 | sessionCounter | 会话级聚合 |
| 成本 | costCounter | USD 成本追踪 |
| Token | tokenCounter | 输入/输出/缓存读/写 |
| 代码 | locCounter | 行增删 |
| PR | prCounter | PR/commit 数 |
| 活跃时间 | activeTimeCounter | 用户活跃时长 |
| 编辑决策 | codeEditToolDecisionCounter | 审批统计 |

### 9.4 事件采样

```typescript
// 动态采样配置（通过 Feature Flag 服务下发）
// 每个事件名独立 sample_rate (0-1)
// 未配置事件默认 100%
```

### 9.5 Datadog 隐私控制

- 用户 SHA256 哈希分 30 桶（隐私保护计数）
- 基数缩减：模型名标准化、版本截断
- 白名单事件（64 个 `tengu_*` 前缀事件）

### 9.6 会话重放

```typescript
// 存储在 bootstrap state
lastAPIRequest              // 最后 API 参数
lastAPIRequestMessages      // 精确压缩后消息
lastClassifierRequests      // 分类器请求
// 支持 /share 命令序列化完整转录
```

---

## 10. 成本控制

### 10.1 分级定价模型

| 层级 | 输入/输出每 Mtok | 适用 |
|------|------------------|------|
| Tier 1 | $0.80 / $4 | 轻量模型 |
| Tier 2 | $1 / $5 | 标准轻量 |
| Tier 3 | $3 / $15 | 标准模型 |
| Tier 4 | $5 / $25 | 高级模型 |
| Tier 5 | $15 / $75 | 旗舰模型 |
| Tier 6 | $30 / $150 | 快速旗舰模型 |

**缓存定价**（所有层级）：写入 25%，读取 10%，搜索 $0.01/次

### 10.2 Token 预算控制

```bash
--max-budget-usd <金额>     # 成本硬限制
--max-turns <轮次>           # 轮次硬限制
--task-budget <tokens>       # API 端 token 预算
```

**成本追踪状态**：

```typescript
{
  totalCostUSD, totalAPIDuration, totalToolDuration,
  totalLinesAdded, totalLinesRemoved,
  modelUsage: {
    [model]: { inputTokens, outputTokens,
               cacheRead, cacheWrite, webSearch, costUSD }
  }
}
```

### 10.3 快速模式经济学

```
标准模式：基础定价
快速模式：6x 成本 → 更快输出
  ↓ 限流
触发冷却期 → 自动回退标准模式
  ↓ 冷却过期
恢复快速模式
```

**可用性检查链**：Feature flag → 仅第一方 → 组织启用 → 订阅层级 → 超额计费

### 10.4 提前停止条件

| 条件 | 触发 |
|------|------|
| `maxBudgetUsd` 超过 | 立即停止，返回错误 |
| `maxTurns` 超过 | 发出 max_turns_reached 后停止 |
| Token Budget ≥ 90% | 评估收益递减后决定 |
| 收益递减 | 3+ 次继续 × < 500 token/次 → 停止 |
| 压缩失败 3 次 | 断路器开启 |

---

# 第五部分：规模化

## 11. 多 Agent 编排

### 11.1 Agent 类型层次

| 类型 | 隔离级别 | 用途 |
|------|----------|------|
| 主 Agent | 无（主循环） | 核心交互 |
| 同步子代理 | 共享 AbortController | 专项任务 |
| 异步子代理 | 独立 AbortController | 后台任务 |
| Fork 子代理 | 继承完整上下文 | 上下文分叉 |
| In-Process Teammate | AsyncLocalStorage 隔离 | 同进程并行 |
| 外部 Teammate | tmux 进程隔离 | 完全隔离 |

### 11.2 上下文隔离模式

**AsyncLocalStorage 层次**：

```typescript
// 每个 Agent 独立上下文
runWithTeammateContext(context, fn)   // 线程本地
runWithCwdOverride(cwd, fn)          // 工作目录隔离

// 优先级链
AsyncLocalStorage → dynamicTeamContext → 环境变量
```

**子代理上下文创建（选择性共享）**：

```typescript
SubagentContextOverrides = {
  readFileState: 克隆（新快照）
  contentReplacementState: 从父级克隆
  abortController: 新控制器（链接到父级）
  getAppState: 包装（自动设 shouldAvoidPermissionPrompts: true）
  setAppState: 默认 no-op（不共享）
  taskDecisions: 新 Set
  queryTracking: 新 chainId（depth + 1）
}
```

### 11.3 通信机制

**文件信箱协议**：

```
~/.claude/teams/{team_name}/inboxes/{agent_name}.json
// Lockfile 保护的并发消息队列
// 重试策略：10 次，5-100ms 退避
```

**结构化协议消息**：

| 类型 | 用途 |
|------|------|
| `permission_request/response` | 工具权限审批 |
| `shutdown_request/approved/rejected` | 生命周期控制 |
| `plan_approval_request/response` | Plan 模式审批 |
| `task_assignment` | 工作分发 |
| `team_permission_update` | 广播权限变更 |
| `idle_notification` | 生命周期通知 |

**结构化消息路由**：`isStructuredProtocolMessage()` 将协议消息从 LLM 上下文中分离

### 11.4 权限继承与冒泡

```typescript
// 父级处于严格模式（bypass/acceptEdits/auto）时不被覆盖
if (parentMode !== 'bypassPermissions' &&
    parentMode !== 'acceptEdits' &&
    parentMode !== 'auto') {
  childMode = agentDefinition.permissionMode  // 可覆盖
}

// bubble 模式：权限请求冒泡到父级终端
// async + 无权限提示能力：自动拒绝
```

### 11.5 Fork 子代理（Prompt Cache 共享）

```
Fork 机制：
1. 继承父级完整对话上下文
2. 工具调用获得占位符结果："Fork started"
3. 所有 fork 生成字节一致 API 前缀 → cache 共享
4. 递归 fork 被阻止（检查 boilerplate tag）

maxTurns: 200
tools: ['*']（继承父级完整工具池）
permissionMode: 'bubble'
```

### 11.6 资源限制

```typescript
TEAMMATE_MESSAGES_UI_CAP = 50    // UI 消息缓冲上限
// 全量历史在磁盘；UI 只展示最近 50 条
// 实测：292 Agent × 2 分钟 → 36.8GB → 安全管理
```

### 11.7 确定性清理

```
finally:
  1. MCP 服务器清理
  2. Session Hook 清理
  3. Prompt Cache 追踪清理
  4. 内存释放（readFileState.clear()）
  5. 遥测清理
  6. AppState 清理（移除 todo 条目）
  7. 后台 Shell 任务终止
  8. Monitor 任务清理
```

---

## 12. 产品化工程

### 12.1 插件架构

```typescript
type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string                     // 'github:owner/repo', 'local', 'builtin'
  // 组件贡献
  commandsPath?: string              // 斜杠命令
  agentsPath?: string                // Agent 定义
  skillsPath?: string                // Skill 目录
  hooksConfig?: HooksSettings        // Hook 配置
  mcpServers?: Record<string, Cfg>   // MCP 服务器
  lspServers?: Record<string, Cfg>   // LSP 服务器
  outputStylesPath?: string          // 输出风格
}
```

**三层插件发现**：
1. Marketplace 插件：`plugin@marketplace` 格式
2. Session 插件：`--plugin-dir` CLI 标志
3. 内联插件：`--plugin` 标志 / SDK

### 12.2 Feature Flag 系统

**双层缓存**：

```
内存（热缓存）← Feature Flag 服务初始化/刷新
    ↓ 同步
磁盘（持久缓存）← 进程重启后存活
```

**刷新周期**：内部用户 20 分钟 / 外部用户 6 小时

**编译时 Gate**：`feature('FLAG')` → 宏展开 → 死代码消除

**运行时 Gate**：`getFeatureValue_CACHED_MAY_BE_STALE<T>()` → 非阻塞读取

### 12.3 配置驱动行为

**设置优先级**（高→低）：

```
用户设置 ~/.settings.json
  ↓
远程托管设置 /api/settings（1 小时轮询）
  ↓
托管文件 ~/.managed-settings.json
  ↓
Drop-in 目录 ~/.managed-settings.d/*.json（字母排序）
  ↓
内置默认值
```

**Fail-open 设计**：获取失败 → 磁盘缓存 → 无缓存跳过

**安全门控**：危险变更显示阻塞对话框；拒绝 = 应用退出

### 12.4 Marketplace 安全

- 保留名称验证（官方名仅允许来自官方组织）
- 非 ASCII 字符阻止（同形文字攻击防护）
- 白名单/黑名单 Marketplace
- 主机/路径 Regex 策略

### 12.5 Skill 系统

**条件激活**：

```typescript
// Skill frontmatter 声明 paths: 匹配模式
// 文件被触碰时 → 匹配的 Skill 从待激活变为可用
conditionalSkills: Map<string, Command>        // 待激活
activatedConditionalSkillNames: Set<string>    // 已激活（存活于缓存清理）
```

**动态发现**：文件读写时向上遍历 → 发现新 Skill 目录 → 加载 → 触发事件

### 12.6 热重载

```
设置变更检测
  ↓
clearAllCaches() → 清除所有记忆化加载器
  ↓
loadAllPlugins() → 从磁盘重新加载
  ↓ 并行
预热 MCP/LSP 服务器连接
  ↓
更新 AppState
  ↓
递增 pluginReconnectKey → 触发 MCP 重连
  ↓
loadPluginHooks() → 原子性 clear-then-register Hook
```

---

## 13. CLI / UX 设计

### 13.1 全链路流式输出

```
API SSE → StreamingToolExecutor → queryLoop → QueryEngine → UI
// 每层都是 AsyncGenerator，延迟最小化
```

### 13.2 进度叙述

每个工具有专用活动描述：

```typescript
getActivityDescription(input): string   // "Reading src/foo.ts"
getToolUseSummary(input): string        // 紧凑展示
```

**Spinner**：动画字符序列 + 减少动画模式支持 + 停滞红色混合

### 13.3 Diff 展示

- Suspense 异步加载（不阻塞终端）
- StructuredDiffList 按块展示行号
- 第一行预览提取

### 13.4 可折叠工具结果

```typescript
isSearchOrReadCommand(input): { isSearch, isRead, isList }
// grep → isSearch; cat → isRead; ls → isList
// 自动折叠减少输出噪音
```

### 13.5 分类器审批反馈

```
BASH_CLASSIFIER:       ✔ Auto-approved · matched "{rule}"
TRANSCRIPT_CLASSIFIER: Allowed by auto mode classifier
```

### 13.6 可中断性

- **Ctrl+C** → AbortController.signal 传播到 API + 工具 + 子进程
- **Escape** → 终端事件解析
- **Submit-interrupt** → 特殊中断类型（跳过中断消息）
- **200ms 恩惠期** → 防止启动误触

---

# 附录

## A. 状态机设计

虽然无显式状态机枚举，通过返回值和转换实现隐式状态机：

```
IDLE → 用户输入
  ↓
PLANNING → fetchSystemPromptParts + normalizeMessages
  ↓
WAITING_API → LLM 流式调用
  ├─ abort → ABORTED
  ├─ end_turn → EVALUATING_STOP
  ├─ tool_use → WAITING_TOOL
  ├─ error(413) → RECOVERING
  └─ FallbackError → FALLBACK
      ↓
WAITING_TOOL → canUseTool()
  ├─ allow → EXECUTING
  ├─ ask → WAITING_APPROVAL
  └─ deny → WAITING_API
      ↓
WAITING_APPROVAL
  ├─ 批准 → EXECUTING
  ├─ 拒绝 → WAITING_API
  └─ 中断 → ABORTED
      ↓
EXECUTING → 工具执行
  ├─ 完成 → WAITING_API（循环）
  ├─ 错误 → WAITING_API（is_error）
  └─ 中断 → ABORTED
      ↓
RECOVERING → 压缩恢复
  ├─ 成功 → WAITING_API
  └─ 失败 → FAILED
      ↓
EVALUATING_STOP
  ├─ Hook 阻止 → RECOVERING
  ├─ Budget 未用完 → WAITING_API
  └─ 正常 → DONE
```

## B. 模型无关架构

**多提供商支持**：

```typescript
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
// 通过环境变量切换
```

**模型别名**：`sonnet`, `opus`, `haiku`, `best`, `sonnet[1m]`, `opus[1m]`

**选择优先级**：运行时命令 > 启动标志 > 环境变量 > 配置 > 默认

**Agent 模型传播**：显式 → inherit（继承父级）→ 默认

**当前局限**：仅支持 Claude 系列模型的不同托管方式，未实现跨厂商抽象

## C. 版本兼容策略

| 策略 | 实现 |
|------|------|
| 工具别名 | `aliases?: string[]` 保留旧名称 |
| Schema 宽松解析 | MCP 用 `z.object({}).passthrough()` |
| JSONL 追加 | 新 Entry 类型追加不影响旧类型 |
| 类型守卫 | `isTranscriptMessage()` 过滤已知类型 |
| 延迟 Schema | `lazySchema()` 允许 feature flag 影响 schema |
| 安装版本化 | 插件侧装（v1 用户/项目分离, v2 多作用域） |
| 崩溃容错 | 截断文件重排 + 边界标记搜索 |

## D. 文件系统与 Workspace

**AsyncLocalStorage CWD**：每个 Agent 独立工作目录，无需全局 `process.chdir()`

**Worktree 隔离**：
- 验证 slug（拒绝遍历、最长 64 字符）
- 符号链接大目录（node_modules）避免磁盘膨胀
- 创建时清除所有缓存（prompt、记忆、plan）
- 退出选择：keep（保留恢复）/ remove（删除目录+分支）

**项目上下文发现**：
- 从工作目录向上遍历到根目录
- 加载所有 CLAUDE.md 和 MEMORY.md
- 按会话 memoize 缓存
- 子代理默认精简 CLAUDE.md
- 只读 Agent 跳过 CLAUDE.md

## E. 用户信任机制

| 机制 | 实现 |
|------|------|
| 命令可见 | 每个 Bash 命令完整展示 |
| Diff 可见 | 文件编辑前展示完整 diff |
| 风险可见 | 三色风险标记（绿/黄/红） |
| 权限可见 | 展示匹配规则或分类器决策 |
| 成本可见 | /cost 命令展示用量和费用 |
| 状态可见 | StatusLine 展示当前权限模式 |
| 进度可见 | Spinner + 活动描述 |
| 决策可见 | 完整溯源链 |
| 历史可恢复 | 100 快照文件历史 |
| 会话可导出 | /share 完整转录 |
| 非黑盒 | 无静默执行；所有工具调用有 UI 表现 |
