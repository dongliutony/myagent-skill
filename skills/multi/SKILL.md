---
name: multi
description: 多 Agent 编排 — 子代理隔离、Fork 机制、通信协议、Worktree、生命周期清理
type: rigid
---

# 多 Agent 编排设计

## 你在解决什么问题
决定何时需要多 Agent、如何隔离上下文、如何通信、如何管理生命周期。

## 参考实现 Snippets
- `snippets/multi/context-isolation.ts` — AsyncLocalStorage 隔离 + 选择性共享 + 权限继承
- `snippets/multi/file-mailbox.ts` — lockfile 信箱 + 结构化协议消息 + 权限请求
- `snippets/multi/deterministic-cleanup.ts` — 8 层清理 + Worktree 创建/清理

## 设计检查清单
- [ ] 默认单 Agent + 多工具；按需升级多 Agent
- [ ] Agent 类型层次：同步/异步/Fork/In-Process/外部
- [ ] AsyncLocalStorage 上下文隔离
- [ ] 子代理默认：readFileState 克隆、setAppState no-op
- [ ] 异步子代理独立 AbortController
- [ ] 文件信箱：lockfile + 10 次重试
- [ ] 结构化协议消息从 LLM 上下文分离
- [ ] 权限继承：严格模式不被覆盖
- [ ] Fork 子代理：字节一致前缀 + 递归阻止
- [ ] UI 消息上限 50 条
- [ ] 8 层确定性清理

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 默认就用多 Agent | 复杂度爆炸 | 按需升级 |
| 共享 AbortController | 父中止杀全部 | 异步独立控制器 |
| 共享 setAppState | 子级污染父级 | 默认 no-op |
| 无消息上限 | 内存爆炸 | UI 50 条 |
| 清理不确定 | 资源泄露 | 8 层 finally |
| 递归 Fork | 指数生成 | 检查 boilerplate tag |
