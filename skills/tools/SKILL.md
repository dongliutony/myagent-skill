---
name: tools
description: 构建工具系统 — 注册表、Schema 验证、权限作用域、沙箱、MCP 集成
type: rigid
---

# 工具系统设计

## 你在解决什么问题
构建 Agent 的工具执行层：如何注册、验证、授权、执行、沙箱化工具。

## 参考实现 Snippets
- `snippets/tools/tool-interface.ts` — 完整工具接口 + buildTool 构建器 + lazySchema
- `snippets/tools/concurrent-executor.ts` — 流式并发执行器（分区 + 进度解耦 + 级联取消）
- `snippets/tools/validation-pipeline.ts` — 三阶段验证（结构→业务→权限）
- `snippets/tools/tool-registry.ts` — 三层注册表 + MCP 包装器

## 设计检查清单
- [ ] 工具接口定义了 inputSchema（Zod）+ outputSchema
- [ ] buildTool() 提供 fail-closed 默认值（不并发、不只读）
- [ ] 三阶段验证：Zod 结构 → validateInput 业务 → checkPermissions 权限
- [ ] 每个工具声明 isConcurrencySafe、isReadOnly、isDestructive
- [ ] 并发执行器：只读并行，写入串行
- [ ] Bash 错误级联取消兄弟，只读错误不级联
- [ ] 进度消息绕过排序立即 yield
- [ ] MCP 工具通过通用包装器集成，透传 Schema
- [ ] 工具名去重（内置优先）+ 固定排序（cache 稳定）
- [ ] Deny 规则在展示时就过滤

## 决策树

### 该工具应该并发安全吗？
```
只读取数据？ → isConcurrencySafe: true
修改文件？ → false
执行 Shell？ → 看具体命令
外部 API？ → 通常 false（除非幂等）
```

### 验证在哪一层？
```
格式错误 → inputSchema（Zod 自动）
业务规则（路径存在、大小限制）→ validateInput()
权限（允许/拒绝/询问）→ checkPermissions()
```

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 默认 isConcurrencySafe: true | 并发写入损坏 | 默认 false |
| 验证在 call() 里做 | 无法区分失败类型 | validateInput 独立 |
| 工具 schema 无排序 | 缓存失效 | 固定排序 |
| 只读错误也级联 | 一个搜索失败全取消 | 仅 Bash 级联 |
| 进度等批次 | UI 无响应 | 进度绕过排序 |
