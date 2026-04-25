---
name: memory
description: 实现记忆与会话系统 — 持久化、三层压缩、选择性召回、文件历史
type: rigid
---

# 记忆与会话设计

## 你在解决什么问题
管理 Agent 的长短期记忆：如何存储、何时压缩、如何召回、如何恢复会话。

## 参考实现 Snippets
- `snippets/memory/auto-compact.ts` — 自动压缩触发 + 断路器 + 两阶段恢复
- `snippets/memory/memory-types.ts` — 四种记忆类型 + 存储格式 + 漂移防护
- `snippets/memory/session-persistence.ts` — JSONL 持久化 + boundary 优化加载

## 设计检查清单
- [ ] 三层压缩：AutoCompact（13k buffer）、Context Collapse、MicroCompact
- [ ] 压缩连续失败 3 次 → 断路器
- [ ] 四种记忆类型（user/feedback/project/reference）
- [ ] 记忆召回用轻量模型选择 Top-5
- [ ] 漂移防护：使用前验证当前状态
- [ ] JSONL 格式 + 文件 > 5MB 时 boundary 优化
- [ ] 文件历史快照上限 100
- [ ] 会话记忆 10k token 后自动初始化

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无断路器 | 压缩无限重试 | MAX_FAILURES = 3 |
| 记忆存代码结构 | 过时后误导 | 只存不能推导的信息 |
| 全量加载大会话 | 恢复慢 | boundary 只加载后半 |
| 召回无漂移检查 | 推荐已删除文件 | 使用前验证 |
