/**
 * 状态指示器 — 用户确定感设计的两个核心组件
 *
 * 设计目标：
 * - 消除 AI 黑盒感：用户始终知道 Agent 在做什么
 * - 提供关键决策信息：用户判断 Agent 是否在做正确/危险的事
 * - 实时反馈：耗时、token 消耗、思考时长 — 减少焦虑
 *
 * 两个核心组件：
 * 1. ToolStatusLine — 绿点 ● + 工具名(参数) + 结果摘要
 * 2. ThinkingIndicator — 红色动画 ✱ + shimmer 扫光文字 + 实时元数据
 */

import React, { useState, useEffect, useRef } from 'react'

// ================================================================
// 组件 1：工具状态行（绿点）
// ================================================================
//
// 展示效果：
//   ● Write(~/.claude/plugins/myagent/snippets/ux/status-indicators.tsx)
//     └ Wrote 195 lines to ../../plugins/myagent/snippets/ux/status-indicators.tsx
//
// 设计原则：
// - 绿点 = "我做了这件事"（已完成/进行中）
// - 工具名(参数) = "我在用什么工具做什么"
// - 结果摘要 = "结果是什么"（一行，不展开）

interface ToolStatusLineProps {
  toolName: string              // "Write", "Read", "Bash", "Edit"
  toolArgs: string              // 工具参数摘要（如文件路径）
  resultSummary?: string        // 一行结果摘要
  status: 'active' | 'completed' | 'error'
}

function ToolStatusLine({ toolName, toolArgs, resultSummary, status }: ToolStatusLineProps) {
  const dotColor = {
    active: 'cyan',       // 执行中 — 青色
    completed: 'green',   // 完成 — 绿色
    error: 'red',         // 错误 — 红色
  }[status]

  return (
    <Box flexDirection="column">
      {/* 主行：● ToolName(args) */}
      <Box>
        <Text color={dotColor}>●</Text>
        <Text> </Text>
        <Text bold>{toolName}</Text>
        <Text dimColor>({toolArgs})</Text>
      </Box>

      {/* 结果摘要行：└ result */}
      {resultSummary && (
        <Box marginLeft={2}>
          <Text dimColor>└ {resultSummary}</Text>
        </Box>
      )}
    </Box>
  )
}

// 工具活动描述生成器 — 每个工具有专用描述
// 这是让用户知道"Agent 在做什么"的关键
function getToolActivityDescription(toolName: string, input: unknown): string {
  switch (toolName) {
    case 'Read':
      return `Reading ${(input as any).file_path}`
    case 'Write':
      return `Writing ${(input as any).file_path}`
    case 'Edit':
      return `Editing ${(input as any).file_path}`
    case 'Bash':
      return `Running: ${truncate((input as any).command, 60)}`
    case 'Glob':
      return `Searching for ${(input as any).pattern}`
    case 'Grep':
      return `Searching for "${truncate((input as any).pattern, 40)}"`
    case 'Agent':
      return `Spawning agent: ${(input as any).description || 'subagent'}`
    default:
      return `Using ${toolName}`
  }
}

// 结果摘要生成器
function getToolResultSummary(toolName: string, result: unknown): string {
  switch (toolName) {
    case 'Write':
      return `Wrote ${(result as any).linesWritten} lines to ${(result as any).path}`
    case 'Edit':
      return `Applied ${(result as any).changesCount} change(s)`
    case 'Bash':
      return `Exit code ${(result as any).exitCode}`
    case 'Grep':
      return `${(result as any).matchCount} matches in ${(result as any).fileCount} files`
    case 'Read':
      return `${(result as any).lineCount} lines`
    default:
      return ''
  }
}

// ================================================================
// 组件 2：思考指示器（红色动画 + shimmer + 元数据）
// ================================================================
//
// 展示效果：
//   ✱ Pretending to think… (3m 3s · ↓ 7.3k tokens · thought for 3s)
//
// 三层信息：
// 1. 动画红点 ✱ — "AI 在处理中"（消除"卡死了吗？"的焦虑）
// 2. Shimmer 文字 — 视觉动感，强化"正在进行"
// 3. 元数据 — 耗时 · token 消耗 · 思考时长（透明化 AI 内部状态）

interface ThinkingIndicatorProps {
  message: string            // "Pretending to think…" / "Planning…" / "Reasoning…"
  startTime: number          // 开始时间戳
  inputTokens?: number       // 输入 token 数
  thinkingDuration?: number  // 思考阶段持续秒数
}

function ThinkingIndicator({
  message,
  startTime,
  inputTokens,
  thinkingDuration,
}: ThinkingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0)
  const [shimmerOffset, setShimmerOffset] = useState(0)

  // 每秒更新耗时
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [startTime])

  // Shimmer 动画（20fps，逐字符扫光）
  useEffect(() => {
    const timer = setInterval(() => {
      setShimmerOffset(prev => (prev + 1) % (message.length + 10))
    }, 50)  // 20fps
    return () => clearInterval(timer)
  }, [message])

  return (
    <Box>
      {/* 红色动画星号 */}
      <AnimatedAsterisk />
      <Text> </Text>

      {/* Shimmer 文字 */}
      <ShimmerText text={message} offset={shimmerOffset} />
      <Text> </Text>

      {/* 元数据 */}
      <Text dimColor>
        ({formatDuration(elapsed)}
        {inputTokens !== undefined && ` · ↓ ${formatTokenCount(inputTokens)} tokens`}
        {thinkingDuration !== undefined && ` · thought for ${thinkingDuration}s`}
        )
      </Text>
    </Box>
  )
}

// ========== 动画红色星号 ==========

function AnimatedAsterisk() {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setInterval(() => {
      setVisible(v => !v)
    }, 500)  // 500ms 闪烁
    return () => clearInterval(timer)
  }, [])

  return <Text color="red">{visible ? '✱' : ' '}</Text>
}

// ========== Shimmer 扫光文字效果 ==========
//
// 原理：一个高亮"窗口"从左到右扫过文字
// 窗口内的字符用亮色，窗口外用暗色
// 视觉上产生"光扫过文字"的效果

const SHIMMER_WINDOW = 5  // 高亮窗口宽度（字符数）

function ShimmerText({ text, offset }: { text: string; offset: number }) {
  return (
    <Text>
      {text.split('').map((char, i) => {
        const distance = Math.abs(i - offset)
        const inWindow = distance < SHIMMER_WINDOW

        return (
          <Text
            key={i}
            color={inWindow ? 'red' : undefined}
            dimColor={!inWindow}
            bold={inWindow && distance < 2}
          >
            {char}
          </Text>
        )
      })}
    </Text>
  )
}

// ========== 辅助函数 ==========

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

// ================================================================
// 组合使用：Agent 循环中的完整状态展示
// ================================================================
//
// 交互流程：
//
// 1. 用户输入 → 思考指示器出现
//    ✱ Thinking… (0s)
//
// 2. 模型开始流式输出 → 思考指示器更新元数据
//    ✱ Generating response… (5s · ↓ 2.1k tokens · thought for 3s)
//
// 3. 工具调用 → 工具状态行出现
//    ● Read(src/query.ts)
//      └ 1729 lines
//
// 4. 多个工具并行 → 多个状态行
//    ● Grep(pattern: "retryWithBackoff")
//      └ 3 matches in 2 files
//    ● Read(src/services/api/withRetry.ts)
//      └ 517 lines
//
// 5. 危险操作 → 权限对话框（红色风险标记）
//    ┌──────────────────────────────────────┐
//    │ Bash(rm -rf node_modules)  [High risk]│
//    │ Do you want to proceed?               │
//    └──────────────────────────────────────┘
//
// 6. 完成 → 最终结果展示

interface AgentStatusDisplayProps {
  phase: 'thinking' | 'streaming' | 'tool_use' | 'waiting_approval' | 'completed'
  thinkingState?: ThinkingIndicatorProps
  activeTools?: ToolStatusLineProps[]
}

function AgentStatusDisplay({ phase, thinkingState, activeTools }: AgentStatusDisplayProps) {
  return (
    <Box flexDirection="column">
      {/* 思考阶段 */}
      {(phase === 'thinking' || phase === 'streaming') && thinkingState && (
        <ThinkingIndicator {...thinkingState} />
      )}

      {/* 工具执行阶段 */}
      {activeTools?.map((tool, i) => (
        <ToolStatusLine key={i} {...tool} />
      ))}
    </Box>
  )
}

// ================================================================
// 设计总结：用户确定感的三层模型
// ================================================================
//
// 层 1：存在感 — "Agent 还活着"
//   → 动画元素（闪烁星号、shimmer 扫光）
//   → 无动画时用户会以为卡死
//
// 层 2：方向感 — "Agent 在做什么"
//   → 工具名 + 参数（Read(src/query.ts)）
//   → 活动描述（"Searching for retryWithBackoff"）
//
// 层 3：掌控感 — "Agent 做得对不对 / 花了多少"
//   → 实时元数据（耗时、token、思考时长）
//   → 风险颜色（绿/黄/红）
//   → 可中断性（Ctrl+C 随时叫停）
//
// 缺少任何一层，用户都会感到不安。
// 三层都有，用户即使不懂技术细节，也会觉得"这个 AI 很靠谱"。
