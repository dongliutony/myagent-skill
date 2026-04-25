---
name: streaming
description: 流式与性能优化 — AsyncGenerator 全链路、并行执行、Prompt Cache、推测执行
type: rigid
---

# 流式与性能优化设计

## 你在解决什么问题
最小化 Agent 响应延迟：全链路流式、并行工具、缓存经济学、推测执行。

## 参考实现 Snippets
- `snippets/streaming/async-generator-chain.ts` — 全链路 Generator 组合 + 消息扣留 + 空闲看门狗
- `snippets/streaming/speculation.ts` — Copy-on-Write overlay + 工具边界 + 流水线建议
- `snippets/streaming/cache-stability.ts` — Cache 失效检测 + hash 追踪 + Fork 前缀共享
- `snippets/tools/concurrent-executor.ts` — 并发分区 + 进度解耦

## 设计检查清单
- [ ] 全链路 AsyncGenerator：API → 执行器 → 循环 → 引擎 → UI
- [ ] 消息扣留：可恢复错误扣留，不可恢复才 yield
- [ ] 90s 空闲看门狗 → 非流式回退
- [ ] 推测执行用 Copy-on-Write overlay
- [ ] 推测边界：只读允许、写入到 overlay、需权限中止
- [ ] Cache 稳定：schema 排序固定 + flag 锁定
- [ ] Cache 失效检测：hash 追踪 + min 2000 token 下降
- [ ] 进度与完成解耦（Promise.race）

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无看门狗 | 连接挂死 | 90s 超时 + 回退 |
| 进度等批次 | UI 无响应 | 绕过排序立即 yield |
| Schema 每次变化 | 缓存失效 | 固定排序 + 锁定 |
| 推测直接写磁盘 | 无法撤销 | overlay |
