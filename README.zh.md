# dsh-plugin-judge · DSH 插件价值裁判

> 判断一个 DeepSeek Harness 插件值不值得用：装前审核，装后审计，模型切换时提醒复核。

[English](README.md)

## 这个插件解决什么问题

插件分两种性质：

- **能力型**：给模型加新能力（新工具、skills、MCP 服务器、服务、命令）——相当于给模型"多长一只手"。
- **约束型**：给模型立规则、上栅栏（注入 system prompt section、persona、写 AGENTS.md、
  拦截 `agent/pre-step` / `tools/pre-execute`、`restrict` / `guard` 工具、`complete: true`
  整块替换提示词）——相当于给模型"套一个笼子"。

约束型插件有一个隐蔽的代价：模型会乖乖按规则做（合规完成得好），但它真正要解决的任务
反而完成得差——规则抢占上下文、压制自主判断，等于给模型的天花板盖了一层低矮的顶。
而且模型一升级，很多"给旧模型打补丁"的规则就从补丁变成了天花板，插件随之失效甚至有害。

**所以：一个插件的价值不是它单方面好坏，而是"插件 × 当前模型"的二元关系。**
本插件就是做这个判断的。

## 功能

| 功能 | 时机 | 形式 |
| --- | --- | --- |
| 装前审核 | 安装之前 | `/plugin-audit <github:owner/repo 或 npm:pkg>` 命令、`judge_plugin` 工具、设置页输入框。拉取插件源码 → 静态扫描 + LLM 裁判 → 给"值不值得装"结论 |
| 装后审计 | 已安装 | 枚举 profile 已装插件 → 逐个扫描分类（能力型/约束型/妆饰型/混合型）→ 压制风险分 → 设置页报告面板 |
| 模型切换提醒 | 模型改变时 | 监听默认模型变化 → 复核"结论依赖旧模型"的插件 → 浮层弹窗提醒复核 |

## 判定方法（两层结合）

1. **规则启发式（免费、确定）**：对插件源码与注入内容做信号扫描，加权得 0–100 压制风险分，
   分类为能力型 / 约束型 / 妆饰型 / 混合型。
2. **LLM 裁判（精细、按需）**：把扫描结果 + 注入内容摘要 + **当前模型身份** 交给模型，
   判断"这套规则对当前这个模型是在帮忙还是压制"，输出结论与理由。

## 使用

```sh
# 安装（需要先有一个 web profile）
dsh plugin --profile web add dsh-plugin-judge

# 或从源码安装
dsh plugin --profile web add <本仓库路径>
```

装好重启 harness 后：

- 聊天里输入 `/plugin-audit github:some/repo` 做装前审核；
- 让模型调用 `judge_plugin` 工具也可以；
- 设置面板里出现「插件裁判」页面：全部已装插件的扫描报告、装前审核输入框、审核历史；
- 切换模型后，若有需要复核的插件，页面浮层会弹出提醒。

## Design

### 数据流

```
已装插件: profile manifest (~/.dsh/profiles/<profile>/package.json → dsh.profile.bundles)
          + 每包的 package.json / lib 源码（node:fs 本地读取）
待装插件: npm registry / jsDelivr / GitHub raw 拉取 package.json + 入口源码（Node fetch）
启发式扫描: 能力信号(+) vs 约束信号(−) 加权 → class + 压制风险分
LLM 裁判: llm.stream(生成式判定, 携带当前模型身份) → verdict + reasons
模型监听: agentDefaultModel.currentSelection() 轮询（回退：agent/request 瀑布观察）
持久化: ~/.dsh/plugin-judge/audits.json（审核历史 + 模型指纹）
桥接: Host ctx.connection.rpc.handle('/plugin-judge', …) ← Client rpc.call 轮询
提醒: Host 产出 pending-reminders → Client 轮询 → shell.overlay 弹窗
报告: Client settings.section「插件裁判」页 + judge_plugin 工具卡片
```

### 信号表（启发式）

能力信号：`tools.register` / `defineTool` / skills / MCP / `webServer.register` /
`registerFetchProvider` / `commands.register` / `provide(` …

约束信号：`systemPrompt.section` / `ctx.systemPrompt` / persona / 写 AGENTS.md /
`agent/pre-step` / `tools/pre-execute` / `tools/execute` 瀑布监听 /
`restrict(` / `guard(` / `complete: true` 整块替换 / 强指令词密度（必须、不得、禁止、
always、never、MUST、NEVER）/ 固定模板指令（严格按照、按以下格式）…

### 目录

```
judgePlugin/
├── package.json          # dsh.bundle.patch + dsh.client.inject + exports（Node >= 18）
├── cordis.patch.yml      # insert: plugin-judge
├── lib/
│   └── index.js          # Host 半：清单盘点 / 拉取源码 / 启发式扫描 / LLM 裁判 /
│                         # 模型监听与提醒 / 工具与命令 / connection RPC 桥 / 持久化
└── client/
    └── client.js         # Client 半（__ModuleLoader__ 格式，无需构建）：
                          # settings.section 报告面板 + shell.overlay 切换提醒浮层
```

### 免责声明

审核结论是启发式 + 模型判断的参考意见，不是安全审计；装任何插件都在你机器上
以你的权限运行第三方代码，安装前请自行阅读源码。
