---
name: prompts
description: 设计 Prompt 管线 — 多层组装、缓存分区、动态注入、压缩策略
type: rigid
---

# Prompt 管线设计

## 你在解决什么问题
构建 Prompt 组装管线：从多个来源、多个层次、多种缓存策略组装最终的系统 prompt。

## 参考实现 Snippets
- `snippets/prompts/prompt-assembly.ts` — 6 级优先级组装 + 静态/动态边界 + 缓存分区
- `snippets/prompts/compact-prompt.ts` — 压缩 prompt 三变体 + 9 必须章节 + 后处理

## 设计检查清单
- [ ] 6 级优先级（Override > Agent > Custom > Default > Append）
- [ ] 静态/动态边界标记分隔
- [ ] 静态部分 scope: 'global'，动态部分 scope: 'org'
- [ ] 每个工具有独立 prompt() 方法
- [ ] 压缩 prompt 强制 `<analysis>` + `<summary>` 结构
- [ ] 压缩保留 9 个必须章节
- [ ] MicroCompact 清理旧工具结果 + 系统 prompt 警告
- [ ] 工具失败用 is_error: true 标记
- [ ] Prompt 分区类型：记忆化 vs 每轮重算

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 单一巨大 prompt 字符串 | 无缓存 | 静态/动态分区 |
| 动态内容在静态区 | 频繁缓存失效 | 边界标记分隔 |
| 压缩丢失原始请求 | 目标偏移 | 9 个必须章节 |
| Feature flag 影响 prompt | 冷/热翻转 | 按会话锁定 |
