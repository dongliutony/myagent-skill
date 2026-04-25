---
name: security
description: 构建权限与安全系统 — 审批模式、规则引擎、风险评分、Hook、分类器
type: rigid
---

# 权限与安全设计

## 你在解决什么问题
构建 Agent 的安全边界：谁能做什么、何时自动执行、何时需要人工审批。

## 参考实现 Snippets
- `snippets/security/permission-decision-cascade.ts` — 六阶段决策级联 + 拒绝跟踪 + 规则匹配
- `snippets/security/hook-system.ts` — PreToolUse/PostToolUse Hook + 原子注册
- `snippets/security/filesystem-guard.ts` — 受保护文件/目录 + 遍历防护 + 风险评分

## 设计检查清单
- [ ] 至少 4 种权限模式（default/acceptEdits/bypass/plan）
- [ ] 规则格式 `toolName(ruleContent)` + 8 种来源优先级
- [ ] 六阶段决策：规则→模式→快速路径→白名单→分类器→用户
- [ ] 三级风险（LOW/MEDIUM/HIGH）+ 颜色
- [ ] 受保护文件/目录白名单 + 路径遍历防护
- [ ] Hook 可审批/阻止/修改输入输出
- [ ] Hook 原子注册（clear-then-register）

## 常见错误
| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 默认 allow all | 安全漏洞 | 默认 ask |
| 分类器阻塞 UI | 用户等待 | 异步非阻塞 |
| 无路径遍历检查 | 读写系统文件 | 拒绝 .. + UNC |
| Hook 无超时 | 挂起 | 配置超时 + abort |
