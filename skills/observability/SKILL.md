---
name: observability
description: 构建可观测性系统 — OTEL 追踪、结构化日志、指标体系、事件采样、会话重放
type: rigid
---

# 可观测性设计

## 你在解决什么问题
让团队能回答：哪个 prompt 最差？哪个工具最慢？token 花在哪？用户在哪步退出？

## 参考实现 Snippets
- `snippets/observability/dual-sink-analytics.ts` — 双写管线 + OTEL + 采样 + 隐私 + 指标定义

## 设计检查清单
- [ ] 双写管线：第一方 + 外部服务
- [ ] 事件队列缓冲（初始化前不丢失）
- [ ] 数据安全标记强制（VERIFIED_NOT_CODE）
- [ ] 用户隐私：SHA256 哈希分 30 桶
- [ ] 基数缩减：模型名标准化、版本截断
- [ ] 动态事件采样（Feature Flag 下发）
- [ ] OTEL：traces + metrics + logs
- [ ] 会话追踪：包装 API 调用为 span
- [ ] 指标：session/cost/token/loc/tool_duration
- [ ] Cache 失效检测追踪

## 必须跟踪的指标
| 维度 | 指标 |
|------|------|
| 成本 | costUSD per model |
| Token | input/output/cacheRead/cacheWrite |
| 延迟 | API duration (with/without retries) |
| 工具 | tool duration + count |
| 权限 | approve/reject count |
| 缓存 | cacheBreak events + diff |

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无安全标记 | 泄露代码 | 强制 VERIFIED |
| 记录原始 ID | 隐私违规 | 哈希分桶 |
| 100% 采样 | 成本高 | 动态采样 |
| 初始化前丢事件 | 缺启动数据 | 队列缓冲 |
