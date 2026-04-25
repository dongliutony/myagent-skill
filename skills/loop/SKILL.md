---
name: loop
description: 设计和实现 Agent 核心循环 — 状态转换、终止条件、轮次控制、中断处理
type: rigid
---

# Agent 循环设计

## 你在解决什么问题
设计 Agent 的核心控制循环：何时继续、何时停止、何时恢复、何时放弃。

## 参考实现 Snippets
- `snippets/loop/loop-state-machine.ts` — 核心 while(true) 循环 + 状态定义 + 终止/继续类型
- `snippets/loop/retry-with-backoff.ts` — 指数退避 + 抖动 + 错误分类 + 持久模式
- `snippets/loop/abort-propagation.ts` — AbortController 树形传播 + 工具中断行为
- `snippets/loop/output-recovery.ts` — 输出 token 多轮恢复（升级→恢复→放弃）
- `snippets/loop/model-fallback.ts` — 连续过载检测 → 模型切换 + 流式回退
- `snippets/loop/token-budget.ts` — Token 预算控制 + 收益递减检测

## 设计检查清单
- [ ] 循环有 `while(true)` + 明确的 `return` 终止点
- [ ] 定义了 LoopState 类型（turnCount、恢复计数器、转换原因）
- [ ] 有硬限制（maxTurns）和软限制（Token Budget）
- [ ] 每种终止状态有明确的 reason 字符串
- [ ] 中断信号通过 AbortController 传播到 API 和工具
- [ ] 模型回退在连续 3 次过载后触发
- [ ] 输出 token 恢复有次数上限（3 次）+ 成功后重置
- [ ] 压缩恢复有防螺旋守卫（hasAttemptedReactiveCompact）
- [ ] 循环是 AsyncGenerator，yield 事件而非 return 结果
- [ ] 重试用指数退避 + ±25% 抖动 + 尊重 Retry-After

## 决策树

### 循环应该继续吗？
```
stop_reason == 'tool_use' → 执行工具后继续
stop_reason == 'end_turn' →
  ├─ Stop Hook 有阻塞错误？ → 注入错误后继续
  ├─ Token Budget 未用完？ → 注入提醒后继续
  └─ 否 → 完成
error == 'prompt_too_long' →
  ├─ Context Collapse 可用？ → 排空后重试
  ├─ 未尝试 Reactive Compact？ → 全量摘要后重试
  └─ 已尝试 → 失败
error == 'max_output_tokens' →
  ├─ 首次？ → 升级 8k→64k
  ├─ 恢复次数 < 3？ → 注入 "继续" 消息
  └─ ≥ 3 → 表面错误
abort signal → 停止
```

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无 maxTurns | 无限循环烧钱 | 始终设置上限 |
| 首次 529 就切模型 | 浪费配额 | 连续 3 次再切 |
| 压缩后不重置计数器 | 误累积 | 成功轮次重置 |
| 中断不清理子进程 | 资源泄露 | AbortController 全链路传播 |
| 恢复无防螺旋 | 无限循环 | hasAttemptedReactiveCompact 守卫 |
| 固定重试间隔 | 雷暴效应 | 指数退避 + 随机抖动 |
