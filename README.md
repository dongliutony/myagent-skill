# myagent — 生产级 AI Agent 开发技能插件

面向 Claude Code 的 Agent 开发技能集，覆盖从核心循环到产品化的 14 个关键领域。

所有设计模式提炼自业界最佳实践 Agent 产品的源码分析，经过生产环境验证。

## 包含内容

| 类别 | Skills | 说明 |
|------|--------|------|
| 路由 | `/myagent` | 自动判断阶段，路由到对应子 skill |
| 核心引擎 | `loop` `tools` `prompts` `memory` | 循环、工具、Prompt 管线、记忆 |
| 安全控制 | `security` `human` | 权限引擎、Human-in-the-Loop |
| 可靠性 | `resilience` `streaming` | 错误恢复、流式性能 |
| 运营 | `observability` `cost` | 可观测性、成本控制 |
| 规模化 | `multi` `production` `ux` | 多 Agent、产品化、CLI/UX |

另含：
- `references/BEST_AGENT_ARCHITECTURE.md` — 1300+ 行架构设计文档
- `snippets/` — 31 个自包含 TypeScript 参考实现（按需加载，不占 context）

## 安装

```bash
# 1. Clone 到 Claude Code 插件目录
git clone https://github.com/dongliutony/myagent-skill.git ~/.claude/plugins/myagent

# 2. 创建符号链接（让 Claude Code 自动发现 skills）
cd ~/.claude/skills
for s in route loop tools prompts memory security human resilience streaming observability cost multi production ux; do
  ln -sf "../plugins/myagent/skills/$s" "myagent-$s"
done
ln -sf "../plugins/myagent/skills/route" "myagent"
```

## 更新

```bash
cd ~/.claude/plugins/myagent && git pull
```

## 使用

在 Claude Code 中直接说：

- "使用 myagent 技能" — 路由 skill 自动判断并调用对应子 skill
- `/myagent` — 同上
- `/myagent-loop` — 直接使用特定子 skill

无需记住子 skill 名称，路由会根据你的任务描述自动选择。

## 目录结构

```
myagent/
├── plugin.json
├── references/
│   └── BEST_AGENT_ARCHITECTURE.md    # 架构设计文档
├── skills/                            # 14 个 skill
│   ├── route/SKILL.md                 # 路由（入口）
│   ├── loop/SKILL.md                  # Agent 循环
│   ├── tools/SKILL.md                 # 工具系统
│   ├── prompts/SKILL.md               # Prompt 管线
│   ├── memory/SKILL.md                # 记忆与会话
│   ├── security/SKILL.md              # 权限安全
│   ├── human/SKILL.md                 # Human-in-Loop
│   ├── resilience/SKILL.md            # 错误恢复
│   ├── streaming/SKILL.md             # 流式性能
│   ├── observability/SKILL.md         # 可观测性
│   ├── cost/SKILL.md                  # 成本控制
│   ├── multi/SKILL.md                 # 多 Agent
│   ├── production/SKILL.md            # 产品化
│   └── ux/SKILL.md                    # CLI/UX
└── snippets/                          # 31 个参考实现
    ├── loop/                          # 状态机、重试、中断、恢复、回退、预算
    ├── tools/                         # 接口、并发执行器、验证管线、注册表
    ├── prompts/                       # 组装、压缩
    ├── memory/                        # 自动压缩、记忆类型、持久化
    ├── security/                      # 决策级联、Hook、文件系统守卫
    ├── human/                         # 渐进信任、反馈、竞赛
    ├── resilience/                    # 优雅降级、断路器
    ├── streaming/                     # Generator 链、推测执行、缓存
    ├── observability/                 # 双写分析、OTEL、采样
    ├── cost/                          # 分级定价、快速模式
    ├── multi/                         # 上下文隔离、信箱、清理
    ├── production/                    # 插件系统、Feature Flag
    └── ux/                            # 进度、Diff、折叠、风险、中断
```

## 许可

仅供学习和研究用途。
