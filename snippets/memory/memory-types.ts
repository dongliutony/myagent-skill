/**
 * 四种记忆类型 + 存储格式
 *
 * 模式：分类存储 + Frontmatter 元数据 + MEMORY.md 索引
 * 关键点：
 * - 只存不能从代码推导的信息
 * - feedback 类型同时记录纠正和确认
 * - project 类型的相对日期转绝对日期
 * - 记忆索引限 200 行 / 25KB
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
type MemoryType = typeof MEMORY_TYPES[number]

// ========== 记忆类型说明 ==========

const MEMORY_TYPE_GUIDE: Record<MemoryType, {
  description: string
  whenToSave: string
  scope: string
}> = {
  user: {
    description: '用户角色、目标、责任、知识偏好',
    whenToSave: '了解到用户身份、偏好、专业背景时',
    scope: '始终私有',
  },
  feedback: {
    description: '工作方式指导 — 纠正和确认',
    whenToSave: '用户纠正做法 或 确认非显然的做法时',
    scope: '私有或团队',
  },
  project: {
    description: '进行中的工作、目标、截止日期、决策',
    whenToSave: '了解谁在做什么、为什么、截止日期时',
    scope: '倾向团队',
  },
  reference: {
    description: '外部系统的位置和用途',
    whenToSave: '了解外部资源及其用途时',
    scope: '通常团队',
  },
}

// ========== 存储格式 ==========

interface MemoryFile {
  frontmatter: {
    name: string
    description: string    // 用于未来相关性判断
    type: MemoryType
  }
  content: string
}

function serializeMemory(memory: MemoryFile): string {
  return `---
name: ${memory.frontmatter.name}
description: ${memory.frontmatter.description}
type: ${memory.frontmatter.type}
---

${memory.content}`
}

// ========== 索引（MEMORY.md） ==========

const MEMORY_INDEX_MAX_LINES = 200
const MEMORY_INDEX_MAX_BYTES = 25 * 1024

// 每行 ~150 字符的指针
// 格式：- [标题](file.md) — 一行摘要
function buildMemoryIndex(memories: MemoryFile[]): string {
  return memories
    .map(m => `- [${m.frontmatter.name}](${m.filename}) — ${m.frontmatter.description}`)
    .join('\n')
}

// ========== 不该存的东西 ==========

const DO_NOT_STORE = [
  '代码模式、约定、架构、文件路径',     // 读代码就行
  'Git 历史、最近变更',                // git log 更准确
  '调试方案、修复配方',                // 修复在代码里，commit message 有上下文
  '已在 CLAUDE.md 中记录的',          // 不重复
  '临时任务详情、当前对话上下文',       // 用任务系统，不用记忆
]

// ========== 漂移防护 ==========

const MEMORY_DRIFT_CAVEAT = `
记忆记录会随时间变得陈旧。使用记忆作为某个时间点的上下文。
在基于记忆回答前，验证记忆是否仍然正确：
- 记忆提到文件路径？→ 先检查文件存在
- 记忆提到函数名？→ 先 grep 确认
- 用户问"当前"状态？→ 用 git log 不用记忆
- 记忆与代码冲突？→ 信任当前代码 + 更新记忆
`
