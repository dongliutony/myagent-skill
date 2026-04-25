/**
 * 上下文压缩 Prompt — 结构化摘要要求
 *
 * 模式：NO_TOOLS 前言 + 分析/摘要双块 + 9 个必须章节
 * 关键点：
 * - 压缩 prompt 禁用工具（maxTurns:1）
 * - 必须输出 <analysis> 草稿 + <summary> 最终摘要
 * - <analysis> 在后处理中被剥离（不进入对话）
 * - 9 个必须章节保证关键信息不丢失
 */

// ========== 压缩 Prompt 变体 ==========

const NO_TOOLS_PREAMBLE = `
IMPORTANT: You must respond with TEXT ONLY. Do NOT use any tools.
Do NOT attempt to call any functions. Simply provide a text response.
This is a summarization task - you have a single turn (maxTurns: 1).
`.trim()

function buildCompactPrompt(variant: 'base' | 'partial' | 'partial_up_to'): string {
  const header = {
    base: 'Summarize the ENTIRE conversation below.',
    partial: 'Summarize only the RECENT messages. You still have access to earlier context.',
    partial_up_to: 'Create a summary to be placed BEFORE the retained messages.',
  }[variant]

  return `
${NO_TOOLS_PREAMBLE}

${header}

You MUST respond in the following format:

<analysis>
Draft your analysis here. This section will be stripped and not shown to anyone.
Use it to organize your thoughts before writing the final summary.
</analysis>

<summary>
## Primary Request & Intent
[Explicit user requests - capture the EXACT intent, not just paraphrased]

## Key Technical Concepts
[Frameworks, technologies, patterns discussed]

## Files & Code Sections
[Full file paths with code snippets and modification reasons.
Include actual code, not just descriptions.]

## Errors & Fixes
[Problems encountered and their resolutions]

## Problem Solving
[Documented troubleshooting steps and outcomes]

## All User Messages
[Non-tool-use messages from the user, preserved verbatim where important]

## Pending Tasks
[Explicitly requested work not yet completed]

## Current Work
[Precisely what was happening at the time of compaction]

## Optional Next Step
[Include direct quotes from recent conversation if applicable]
</summary>
`.trim()
}

// ========== 后处理：剥离 <analysis> ==========

function formatCompactSummary(rawResponse: string): string {
  // 移除 <analysis>...</analysis>（草稿区）
  let cleaned = rawResponse.replace(
    /<analysis>[\s\S]*?<\/analysis>/g,
    ''
  )

  // 将 <summary>...</summary> 替换为可读格式
  cleaned = cleaned
    .replace(/<summary>\s*/, '## Conversation Summary\n\n')
    .replace(/\s*<\/summary>/, '')

  return cleaned.trim()
}

// ========== 压缩后重注入 ==========

const POST_COMPACT_CONFIG = {
  maxFilesToRestore: 5,           // 最多恢复 5 个近期文件内容
  tokenBudget: 50_000,            // 重注入总预算
  maxTokensPerFile: 5_000,        // 单文件上限
  maxTokensPerSkill: 5_000,       // 单 Skill 上限
  skillsTokenBudget: 25_000,      // Skill 总预算
}

// 压缩前剥离图片（避免压缩 API 本身过长）
function stripImagesBeforeCompact(messages: Message[]): Message[] {
  return messages.map(msg => ({
    ...msg,
    content: Array.isArray(msg.content)
      ? msg.content.map(block =>
          block.type === 'image' ? { type: 'text', text: '[image shared]' } : block
        )
      : msg.content,
  }))
}
