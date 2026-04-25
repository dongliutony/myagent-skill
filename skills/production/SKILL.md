---
name: production
description: 产品化工程 — 插件架构、Feature Flag、配置驱动、Marketplace、热重载、灰度回滚
type: flexible
---

# 产品化工程设计

## 你在解决什么问题
让 Agent 系统可维护、可扩展、可灰度发布。

## 参考实现 Snippets
- `snippets/production/plugin-system.ts` — 插件架构 + Manifest + 三层发现 + 热重载 + 条件激活
- `snippets/production/feature-flags.ts` — 双层缓存 + 编译时/运行时 Gate + 配置驱动

## 设计检查清单
- [ ] 插件可贡献：命令/Agent/Skill/Hook/MCP/LSP
- [ ] Manifest Zod 验证（宽松顶层 + 严格嵌套）
- [ ] 三层发现：Marketplace + Session + 内联
- [ ] Feature Flag 双层缓存（内存 + 磁盘）
- [ ] 编译时 Gate（死代码消除）+ 运行时 Gate（非阻塞）
- [ ] 设置优先级：用户 > 远程 > 托管 > Drop-in > 默认
- [ ] 远程设置 fail-open
- [ ] 条件 Skill 激活（路径匹配时加载）
- [ ] 热重载原子性（clear-then-register）
- [ ] Marketplace 安全（保留名 + 同形文字防护）

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 无 Manifest 验证 | 恶意插件 | Zod 验证 |
| Flag 阻塞启动 | 启动慢 | 5s 超时 + 默认值 |
| 远程无 fail-open | 单点故障 | 磁盘缓存 + 跳过 |
| 热重载非原子 | Hook 死亡窗口 | clear-then-register |
