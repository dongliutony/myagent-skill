---
name: resilience
description: 实现错误恢复与韧性 — 分层重试、模型回退、优雅降级、部分成功
type: rigid
---

# 错误恢复与韧性设计

## 你在解决什么问题
让 Agent 在面对网络错误、API 限流、上下文溢出、工具失败时能恢复或优雅降级。

## 参考实现 Snippets
- `snippets/loop/retry-with-backoff.ts` — 指数退避 + 错误分类 + 持久模式
- `snippets/loop/model-fallback.ts` — 模型回退 + 流式回退
- `snippets/loop/output-recovery.ts` — 输出 token 多轮恢复
- `snippets/memory/auto-compact.ts` — 两阶段压缩恢复 + 断路器
- `snippets/resilience/graceful-degradation.ts` — fail-open + 断路器 + 非致命初始化

## 设计检查清单
- [ ] API 重试：指数退避 + 抖动 + Retry-After
- [ ] 连续 529 × 3 → 模型回退
- [ ] 认证错误 → Token/OAuth 刷新
- [ ] 网络错误 → 禁用 keep-alive
- [ ] 上下文溢出 → 两阶段恢复（Collapse → Compact）
- [ ] 恢复有防螺旋守卫
- [ ] 远程服务/Flag 失败 → fail-open
- [ ] 压缩失败 3 次 → 断路器
- [ ] 只读工具独立失败，仅 Bash 级联

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 固定重试间隔 | 雷暴 | 指数退避 + 抖动 |
| 首次错误就回退 | 浪费配额 | 连续计数阈值 |
| 无 fail-open | 单点阻塞 | 缓存回退 + 跳过 |
| 无断路器 | 无限重试 | MAX_FAILURES |
| 所有错误级联 | 一挂全挂 | 仅破坏性级联 |
