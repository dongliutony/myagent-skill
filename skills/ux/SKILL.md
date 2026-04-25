---
name: ux
description: CLI/UX 设计 — 进度叙述、Diff 展示、可中断性、透明度、用户信任
type: flexible
---

# CLI / UX 设计

## 你在解决什么问题
通过交互设计让用户觉得 Agent "智能"且"可控"。

## 参考实现 Snippets
- `snippets/ux/status-indicators.tsx` — **核心**：工具状态行（绿点）+ 思考指示器（红色 shimmer + 实时元数据）— 用户确定感设计
- `snippets/ux/progress-and-transparency.tsx` — Spinner + Diff + 折叠 + 风险颜色 + 分类器反馈 + 可中断

## 用户确定感的三层模型

**最重要的 UX 设计原则** — 缺少任何一层，用户都会感到不安：

| 层 | 问题 | 解决 | 组件 |
|----|------|------|------|
| 存在感 | "卡死了吗？" | 动画元素（闪烁 ✱、shimmer 扫光） | ThinkingIndicator |
| 方向感 | "在做什么？" | 工具名 + 参数 + 结果摘要 | ToolStatusLine |
| 掌控感 | "做得对吗？花了多少？" | 实时元数据 + 风险颜色 + 可中断 | 元数据 + RiskBadge |

### 工具状态行（绿点 ●）
```
● Write(~/.claude/plugins/myagent/snippets/ux/status-indicators.tsx)
  └ Wrote 195 lines to status-indicators.tsx
```
- 绿点 = "我做了这件事"
- 工具名(参数) = "我用什么工具做什么"
- 结果摘要 = "结果是什么"

### 思考指示器（红色动画 ✱ + shimmer + 元数据）
```
✱ Pretending to think… (3m 3s · ↓ 7.3k tokens · thought for 3s)
```
- 红色闪烁 ✱ = "AI 在处理中"
- Shimmer 扫光 = 视觉动感强化"正在进行"
- 元数据 = 耗时 · token 消耗 · 思考时长

## 设计检查清单
- [ ] **工具状态行**：每个工具调用展示 ● + 工具名(参数) + 结果摘要
- [ ] **思考指示器**：动画 ✱ + shimmer 扫光 + 实时元数据（耗时·token·思考时长）
- [ ] 全链路流式输出
- [ ] 每个工具有 getActivityDescription（"Reading src/foo.ts"）
- [ ] Spinner + 减少动画模式 + 停滞红色
- [ ] Diff 异步加载（Suspense）
- [ ] 搜索/读取自动折叠
- [ ] 分类器审批可视反馈（✔ Auto-approved）
- [ ] 风险三色：绿/黄/红
- [ ] Ctrl+C 传播到 API + 工具 + 子进程
- [ ] 200ms 恩惠期
- [ ] 成本展示 + 转录导出

## 用户信任清单
| 机制 | 目的 |
|------|------|
| 命令完整展示 | 知道要执行什么 |
| Diff 展示 | 知道要改什么 |
| 风险颜色 | 知道危险程度 |
| 审批规则展示 | 知道为什么自动 |
| 进度展示 | 知道在做什么 |
| 可中断 | 随时叫停 |
| 文件历史 | 随时回滚 |
| 转录导出 | 随时审计 |

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无进度反馈 | 用户以为卡死 | 活动描述 |
| Diff 同步加载 | 终端卡顿 | Suspense 异步 |
| 所有结果展开 | 噪音 | 搜索/读取折叠 |
| 中断不清理 | 状态损坏 | AbortController 全链路 |
