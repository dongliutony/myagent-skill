---
name: cost
description: 实现成本控制 — 分级模型路由、Token 预算、Prompt Cache 经济学、提前停止
type: rigid
---

# 成本控制设计

## 你在解决什么问题
控制 LLM Agent 运行成本：选择模型、管理预算、优化缓存、及时停止。

## 参考实现 Snippets
- `snippets/cost/tiered-pricing.ts` — 定价层级 + 成本追踪 + 快速模式 + 预算硬限制
- `snippets/loop/token-budget.ts` — Token 预算 + 收益递减检测
- `snippets/streaming/cache-stability.ts` — Cache 经济学 + TTL 选择

## 设计检查清单
- [ ] 分级定价：缓存读取 10%，写入 25%
- [ ] per-model 成本追踪
- [ ] --max-budget-usd 硬限制
- [ ] --max-turns 轮次硬限制
- [ ] Token Budget 软限制 + 收益递减（3次 × <500 token）
- [ ] 快速模式 6x 成本 + 限流冷却
- [ ] 子代理路由到便宜模型
- [ ] 压缩断路器防止无限 API 调用

## 成本优化清单
1. Prompt Cache：固定排序 + flag 锁定 + global scope
2. MicroCompact：清理旧结果释放 token
3. 收益递减：连续低产出时提前停止
4. 模型分级：探索/召回用便宜模型
5. Fork Cache 共享：字节一致前缀

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无预算上限 | 失控烧钱 | --max-budget-usd |
| 子代理用旗舰 | 成本爆炸 | Flag 路由便宜模型 |
| Cache 不稳定 | 浪费写入费 | 固定排序 + 锁定 |
| 无收益递减 | 低效循环 | 3次 × <500 停止 |
