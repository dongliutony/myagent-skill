/**
 * CLI/UX 模式 — 进度叙述 + Diff 展示 + 可折叠 + 风险颜色
 *
 * 模式：React/Ink 终端 UI + Suspense 异步 + 三色风险
 * 关键点：
 * - 每个工具有 getActivityDescription（Spinner 文字）
 * - Diff 异步加载（Suspense，不阻塞终端）
 * - 搜索/读取结果自动折叠
 * - 风险三色：绿（LOW）/ 黄（MEDIUM）/ 红（HIGH）
 * - 分类器审批有可视反馈
 */

import React, { Suspense } from 'react'

// ========== Spinner 组件 ==========

interface SpinnerProps {
  message: string        // 活动描述，如 "Reading src/foo.ts"
  isStalled?: boolean    // 停滞时混合红色
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const REDUCED_MOTION_INTERVAL = 2000  // 减少动画模式

function Spinner({ message, isStalled }: SpinnerProps) {
  const [frameIndex, setFrameIndex] = React.useState(0)
  const prefersReducedMotion = useReducedMotion()

  React.useEffect(() => {
    if (prefersReducedMotion) {
      // 减少动画：闪烁点
      const timer = setInterval(() => {
        setFrameIndex(prev => (prev + 1) % 2)
      }, REDUCED_MOTION_INTERVAL)
      return () => clearInterval(timer)
    }

    const timer = setInterval(() => {
      setFrameIndex(prev => (prev + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [prefersReducedMotion])

  const glyph = prefersReducedMotion
    ? (frameIndex === 0 ? '●' : ' ')
    : SPINNER_FRAMES[frameIndex]

  const color = isStalled ? 'red' : 'cyan'

  return (
    <Text>
      <Text color={color}>{glyph}</Text>
      <Text> {message}</Text>
    </Text>
  )
}

// ========== Diff 展示（异步） ==========

function FileEditDiff({ oldContent, newContent, filePath }: DiffProps) {
  return (
    <Suspense fallback={<Text dimColor>…</Text>}>
      <AsyncDiffContent
        oldContent={oldContent}
        newContent={newContent}
        filePath={filePath}
      />
    </Suspense>
  )
}

function AsyncDiffContent({ oldContent, newContent, filePath }: DiffProps) {
  const diff = useDiffComputation(oldContent, newContent)

  return (
    <Box borderStyle="dashed" paddingX={1}>
      <Text bold>{filePath}</Text>
      {diff.hunks.map((hunk, i) => (
        <DiffHunk key={i} hunk={hunk} />
      ))}
    </Box>
  )
}

function DiffHunk({ hunk }: { hunk: Hunk }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</Text>
      {hunk.lines.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined}
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}

// ========== 可折叠工具结果 ==========

interface CollapsibleResult {
  isSearch: boolean   // grep → 折叠
  isRead: boolean     // cat → 折叠
  isList: boolean     // ls → 折叠
}

function ToolResultDisplay({ tool, result }: { tool: Tool; result: ToolResult }) {
  const collapse = tool.isSearchOrReadCommand(result.input)
  const shouldCollapse = collapse.isSearch || collapse.isRead || collapse.isList

  if (shouldCollapse) {
    return <CollapsedResult summary={tool.getToolUseSummary(result.input)} />
  }

  return <ExpandedResult result={result} />
}

// ========== 风险颜色 ==========

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

const RISK_DISPLAY: Record<RiskLevel, { color: string; label: string }> = {
  LOW:    { color: 'green',  label: 'Low risk' },
  MEDIUM: { color: 'yellow', label: 'Med risk' },
  HIGH:   { color: 'red',    label: 'High risk' },
}

function RiskBadge({ level }: { level: RiskLevel }) {
  const { color, label } = RISK_DISPLAY[level]
  return <Text color={color}>[{label}]</Text>
}

// ========== 分类器审批反馈 ==========

function ClassifierApprovalDisplay({ result }: { result: ClassifierResult }) {
  if (result.classifier === 'BASH_CLASSIFIER') {
    return (
      <Text color="green">
        ✔ Auto-approved · matched "{result.matchedDescription}"
      </Text>
    )
  }

  return (
    <Text dimColor>
      Allowed by auto mode classifier
    </Text>
  )
}

// ========== 权限对话框 ==========

function PermissionDialog({
  title,
  subtitle,
  riskLevel,
  children,
}: {
  title: string
  subtitle?: string
  riskLevel?: RiskLevel
  children: React.ReactNode
}) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        {riskLevel && <RiskBadge level={riskLevel} />}
      </Box>
      {subtitle && <Text dimColor>{subtitle}</Text>}
      {children}
    </Box>
  )
}

// ========== 可中断性 ==========

function useInterruptHandler(
  abortController: AbortController,
): void {
  React.useEffect(() => {
    const handler = () => {
      abortController.abort('user_interrupted')
    }

    // Ctrl+C
    process.on('SIGINT', handler)

    return () => {
      process.off('SIGINT', handler)
    }
  }, [abortController])
}
