<div align="center">
  <img src="icon.svg" alt="OpenCode on DeepSeek Harness" width="112" />
  <h1>dsh-opencode-patch</h1>
  <p><b>OpenCode on DeepSeek Harness</b><br />网关来源头 · 会话亲和 · 免费层工具回退 · 实时双模式额度计量</p>

  <p>🇬🇧 <a href="./README.md">English</a> &nbsp;·&nbsp; 🇨🇳 <b>简体中文</b></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-opencode-patch"><img src="https://img.shields.io/npm/v/dsh-opencode-patch.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/dsh-opencode-patch"><img src="https://img.shields.io/npm/dm/dsh-opencode-patch.svg" alt="npm downloads" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml"><img src="https://github.com/viztor/dsh-opencode-patch/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml"><img src="https://github.com/viztor/dsh-opencode-patch/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
    <a href="https://github.com/viztor/dsh-opencode-patch/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-opencode-patch.svg" alt="license" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/dsh-opencode-patch.svg" alt="node" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" alt="TypeScript" /></a>
    <a href="#-quick-start"><img src="https://img.shields.io/badge/DSH-host%20plugin-4D6BFE.svg" alt="DSH host plugin" /></a>
    <a href="#-quick-start"><img src="https://img.shields.io/badge/config-zero-8B5CF6.svg" alt="zero-config" /></a>
    <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
  </p>

  <p>
    <a href="#-快速开始">快速开始</a> ·
    <a href="#-修复的问题">修复的问题</a> ·
    <a href="#-界面">界面</a> ·
    <a href="#-配置参考">配置</a> ·
    <a href="#-故障排查">故障排查</a> ·
    <a href="./CHANGELOG.md">更新日志</a> ·
    <a href="./CONTRIBUTING.md">贡献指南</a>
  </p>
</div>

---

`dsh-opencode-patch` 是一个 DeepSeek Harness 宿主插件，让 **OpenCode Zen 与 Go** 模型在 DSH 内持续可用。无需遭遇网络拒绝、Cloudflare 挑战、权益不匹配或隐形限制，即可接入 `claude-sonnet-4-5`、`gpt-5.4`、`gemini-3.8-flash`、`deepseek-v4.1-flash`、`muse-spark-1.3-contributor-free`、`qwen3.8-flash` 以及 OpenCode 目录中的其余模型。

OpenCode 网关要求 DSH 默认不会发送的请求特征：每一轮都携带有效的 `x-opencode-session`、官方 CLI 的来源证明（`User-Agent`、client/project 请求头、`ses_…` 形式的 ID），以及免费层请求上的 `read`/`bash` 工具定义。DSH 子代理、后台评估以及 **Auto Review** 等实验模式，还会在 `sessionId` 缺失或未关联的独立会话中调用 LLM。

插件在网络层补齐所有缺失的协议要素——**且仅针对 OpenCode 路由**（`opencode` / `opencode-go` / `opencode-responses` / `opencode-anthropic`）。其余全部流量（DeepSeek、OpenAI、Anthropic、GitHub）原样通过。

**亮点**

- 🔑 确定性的 `ses_<12hex><14base62>` 会话哈希，跨轮次、子代理与分叉保持 KV 缓存亲和
- 🌐 网关来源恢复——`User-Agent`、`x-opencode-client`、`x-opencode-project`、父会话谱系
- 🧰 免费层 `read` + `bash` 工具 schema 回退，让 Zen 免费模型不再报 `403 FreeTierError`
- 📇 基于 models.dev 的模型目录，带离线预置与后台 SWR 刷新——名称、上下文窗口、价格
- ⭕ 实时双模式停靠栏计量——Go 额度环（5 小时 / 每周 / 每月）或 Zen 按量计费胶囊，外加会话消耗与模型费率
- 🕵️ 严格凭据隔离——Zen 密钥（`oc_sk_…`）绝不查询 Go 额度端点

**目录**

1. [快速开始](#-快速开始)
2. [修复的问题](#-修复的问题)
3. [支持的模型与协议](#-支持的模型与多协议路由)
4. [界面](#-界面)
5. [配置参考](#-配置参考)
6. [故障排查](#-故障排查)
7. [兼容性与验证](#-兼容性与验证)
8. [深入解析：协议规范](#-深入解析协议规范)
9. [署名与许可](#-署名与许可)

---

## 🚀 快速开始

**1. 安装**到你的 DSH Web profile（Node 24+）：

```sh
cd ~/.dsh/profiles/web
npm install dsh-opencode-patch
```

同一代码树还发布作用域别名 [`@viztor/dsh-opencode-patch`](https://www.npmjs.com/package/@viztor/dsh-opencode-patch) 与 [`@viztor/dsh-opencode`](https://www.npmjs.com/package/@viztor/dsh-opencode)——任选其一安装，行名仍是 `dsh-opencode-patch`。

**2. 启用 bundle**——把该包加入 profile 的 `dsh.profile.bundles` 数组：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-opencode-patch": "^0.12.0",
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-opencode-patch"],
      "patchReload": "live",
    },
  },
}
```

**3. 添加凭据**，让额度计量能解析到密钥——在 DSH Credentials 或你的环境变量中存储 `OPENCODE_GO_API_KEY`（Go 订阅，`sk-…`）和/或 `OPENCODE_API_KEY`（Zen 按量计费，`oc_sk_…`）。

**4. 重启 `dsh web`。** 宿主 bundle 只在启动时导入（`hmr root: []`），因此要重启才会加载 `lib/index.mjs`；客户端 UI 变更（`lib/client.js`）只需刷新浏览器。

完成——**OpenCode 补丁设置**卡片会出现在 _Settings → Plugins_ 下，一旦有 OpenCode 模型激活，计量表就会挂载到输入框停靠栏。

---

## 🔌 修复的问题

| 没有补丁时 | 使用 `dsh-opencode-patch` 后 |
| :-- | :-- |
| Zen 免费模型报 `403 FreeTierError` | 自动恢复**网关来源头与工具回退** |
| 会话 ID 被拒并返回 `400 MissingSessionID` | **确定性的 `ses_…` 会话哈希**与跨轮次亲和 |
| 子代理丢失对话上下文 | **父会话跟踪**（`x-opencode-parent-session-id`、`x-parent-session-id`） |
| Auto Review 调用报 `TRANSPORT: Connection error` | **回退会话轮次捕获**，在评估调用之间保留轮次状态 |
| 额度与余额不可见 | **实时双模式停靠栏计量**，显示 Go 额度或 Zen 按量计费 |
| Zen 密钥在 Go 用量上触发 `403 EntitlementError` | **严格凭据隔离**，让 Zen 密钥不接触 Go 端点 |
| 所有项目共用一个 `"global"` 遥测桶 | **动态工作区归属**，由当前 `session.header.cwd` 解析 |
| 网关 `/models` 返回截断且无名称的列表 | **models.dev 补全**：显示名、上下文窗口与价格 |

---

## 🧭 支持的模型与多协议路由

OpenCode 通过一个网关在多种上游协议上提供推理，本补丁覆盖全部四类协议。

### 1. OpenCode Zen (`provider: opencode`) — 按量计费与免费额度

- **Anthropic Messages** (`https://opencode.ai/zen/v1/messages`)：`claude-sonnet-4-5`、`claude-opus-4-7`、`claude-haiku-4-5`、`qwen3.8-flash`
- **OpenAI Responses** (`https://opencode.ai/zen/v1/responses`)：`gpt-5.4`、`gpt-5.2`、`gpt-5.1-codex-max`、`muse-spark-1.3`、`space-bunny-free`，以及免费层的 `muse-spark-1.3-contributor-free`
- **OpenAI Chat Completions** (`https://opencode.ai/zen/v1/chat/completions`)：`deepseek-v4.1-flash`、`kimi-k2.5`、`kimi-k3`、`minimax-m2.5`、`glm-5.2`，外加免费层的 `nemotron-3-ultra-free`、`ling-3.0-flash-fin-free`、`mimo-v2.6-flash-free`
- **Google Generative AI** (`https://opencode.ai/zen/v1/models/*:streamGenerateContent`)：`gemini-3.8-flash`、`gemini-3.1-pro`、`gemini-3.5-flash-lite`

### 2. OpenCode Go (`provider: opencode-go`) — 订阅额度

- **OpenAI Chat Completions** (`https://opencode.ai/zen/go/v1/chat/completions`)：`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`qwen3.8-flash`、`qwen3.8-max`、`qwen3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`grok-4.7`、`grok-4.6`、`minimax-m3`、`minimax-m2.7`、`mimo-v2.6-pro`、`mimo-v2.6-flash`、`gpt-5.6-luna`、`gpt-6-luna`
- 由实时三窗口额度计量监控（5 小时滚动、每周、每月）。完整集合随内置目录发布——参见[权威模型目录](#7-权威模型目录双本地预置--实时-swr-更新)。

### 3. 模型的协议是怎么定的 —— 以及为什么你什么都不用配

Zen 的 provider 级 SDK 是 `@ai-sdk/openai-compatible`。models.dev **只在该模型需要不同 SDK 时**才逐模型标注 `provider.npm` —— 所以这个字段的**存在本身就是信号**，它决定走哪条线路协议。没有任何手工匹配：

| models.dev `provider.npm` | 模型数 | 协议 | 服务自 |
| :-- | --: | :-- | :-- |
| _（缺失）_ | 26 | OpenAI Chat Completions | 你配置的路由 |
| `@ai-sdk/openai` | 30 | OpenAI Responses | `opencode-responses` |
| `@ai-sdk/anthropic` | 17 | Anthropic Messages | `opencode-anthropic` |
| `@ai-sdk/google` | 7 | _（DSH 无此协议）_ | **不提供** |

数量为 `models.dev` 中 `opencode` 的 80 个**在用**模型，统计于 2026-10-05 —— 列出的 116 个里其余 36 个已废弃或下架，补丁只内置网关仍在服务的部分。同样这 80 个模型离线内置在 `src/catalog-data.ts`，因此在第一次 catalog 刷新之前它们每一个路由都是正确的；用 `pnpm run catalog:shim` 重新生成该文件。

插件把这两条内部路由同时挡在模型选择器和 _Settings → Models_ 之外。**三条性质今天就成立，还有一条尚未成立：**

- **你的挑选仍然有效。** 选择器显示的就是你列出的模型，每个模型都会**自动匹配到正确的协议**。OpenCode 的模型分布在三种形状上——OpenAI Chat Completions（默认）、OpenAI Responses、Anthropic Messages——需要后两种的模型会被派发到对应路由。不需要手工声明第二条路由。
- **永远不会提供跑不通的模型。** 那 8 个 `@ai-sdk/google` 模型会从"获取可用模型"**和** `opencode` 路由自己的报告中**双双剔除** —— DSH 没有对应协议，选了只会失败，而且行里没有任何东西能告诉你原因。
- **一份凭据。** 所有路由模型共用你已配置的 `opencode` key，经凭据服务解析，**不会重新问你要**。

**如果你更想自己声明路由**：`opencode-responses`（以及你用上 Anthropic 平面模型后的 `opencode-anthropic`）可以写进 profile 的 `llm-pi-ai` `providers` 块里，并列出它服务的模型。声明是一个选择，不是要求：

```yaml
opencode-responses:
  api: openai-responses
  baseURL: https://opencode.ai/zen/v1
  headers:
    authorization: Bearer unused # 由 fetch 补丁换成你的 key
  models:
    - id: muse-spark-1.3-contributor-free
      name: Muse Spark 1.3 Free
      contextWindow: 1048576
      maxTokens: 131072
      input: [text, image]
```

**这条路由由插件替你注册**，所以上面那段配置是可选的。`responses-provider.ts` 会在进程内挂载宿主自己的 `llm-pi-ai`：隔离 authorization 与 settings 两个接缝，并在一层只转发 adapter 注册的 `llm` 门面之后挂载——因此它既不会重复登记整个 catalog 目录、settings 命名空间，也不会多注册任何一条 sign-in flow。这一版是对着真实 harness 验证的，不是桩：路由注册成功，宿主自己的 41 条 catalog 与 41 条 sign-in flow 原封不动，卸载时该路由被撤回。

这些路由继承**你的**凭据：每一条都沿用你 `opencode` 路由已经声明的同一个 `apiKeyEnv`，所以自定义的 key 引用不需要你再说一遍。你在 profile 里已经声明过的路由会被尊重——插件不会覆盖你的模型列表。

若宿主没有已加载的 `llm-pi-ai` 条目，插件不会注册任何东西，只会在日志里说明；此时请在 profile 里显式声明该路由。

### 4. 覆盖的执行模式

| 模式 | 补丁做什么 |
| :-- | :-- |
| **交互式多轮对话** | 通过每会话稳定的 `ses_…` id 提供 KV 提示缓存亲和 |
| **子代理与分叉** | 子、父会话都参与哈希；谱系由父级请求头携带 |
| **Agent 团队** | 跨编排轮次保留共享工作区的归属信息 |
| **实验性 Auto Review** | 即使后台审计调用省略 `sessionId`，仍会得到确定性的轮次状态、请求头与工具回退 |

---

### 5. 目录：合并了什么，谁说了算

模型清单由四个来源拼成，每个来源回答的是不同的问题：

| 来源             | 回答                                           |
| :--------------- | :--------------------------------------------- |
| 内置 shim        | 一次网络请求都还没有时能提供什么——冷启动、离线 |
| models.dev       | 规范参数、价格与显示名                         |
| 网关的 `/models` | **这个账号**实际能用什么                       |
| 发现装饰         | `discoverModels` 该回答什么                    |

合并是**增量式**的：适配器给的行保留，规范行只在缺失时追加，只有当按 provider 记录的退役名单点名某个模型时才省略它——那是事实，不是猜测。显示名与价格取自 models.dev，因为网关列表只给 id，别的几乎没有。

有两点你在使用中会注意到。**冷启动永远不为空**——内置 shim 在第一次刷新前就能回答，选择器立刻有模型可选。而且**models.dev 里没有条目的模型照样出现**，费率位置显示 `—`：既不猜，也不会退回去显示上一个模型的名字。

两个生成文件都在 CI 里校验（`catalog:shim`、`limits:shim`）；厂商数据变动时它们以非零码退出——这是唯一能发现 models.dev 在你背后变了的办法。

→ 协议路由、合并与界面的技术细节： [`docs/protocol-routing-and-merge.zh-CN.md`](./docs/protocol-routing-and-merge.zh-CN.md) · [English](./docs/protocol-routing-and-merge.md)

## 🖥 界面

### 设置卡片 — _Settings → Plugins → OpenCode 补丁设置_

三个分区共八个控件——都是用户真正会做出的决定。所有控件都基于平台自身的原语渲染（`Switch`、`Tag`、`Button`、宿主 token），每个配置项都带提示以及恢复默认的操作。

| 分区 | 控件 | 默认 | 作用 |
| :-- | :-- | :-: | :-- |
| **网关请求** | 恢复 User-Agent（默认开启） | `on` | 恢复官方 OpenCode CLI 的 `User-Agent`，使 Cloudflare WAF 校验通过 |
| **网关请求** | 注入客户端来源头（默认开启） | `on` | 在网关流量上注入 `x-opencode-client`（以及来源请求头集合） |
| **网关请求** | 附带工作区项目标识（默认开启） | `on` | 用当前文件夹名标记 `x-opencode-project`；关闭则省略该请求头 |
| **模型与免费额度** | 使用 models.dev 补全模型列表（默认开启） | `on` | 将规范参数、显示名、价格与当前免费模型合并进列表**以及**原生 DSH 模型发现 |
| **模型与免费额度** | 自动补全核心工具（默认开启） | `on` | 补上免费层 `/responses` 请求体所需的 `read` + `bash` schema |
| **配额计量** | 开启 OpenCode Go 额度监控（默认开启） | `on` | 在输入框停靠栏挂载实时额度 / 余额计量表 |
| **配额计量** | 显示会话消耗与模型费率（默认开启） | `on` | 追加显示本会话累计花费与当前模型每百万 Token 费率 |
| **配额计量** | 凭据来源 | `auto` | 多个密钥同时可用时以哪个为准：**自动** · **优先实时请求** · **优先已声明密钥** |

覆盖类配置项（字面字符串、标记、路由列表）刻意只留在配置里，让默认值适用于所有有文档记载的配置——参见[配置参考](#-配置参考)。

卡片在控件上方还带一份**实时的 Go 用量摘要**——和输入框计量表同一个读数，但用官方控制台的排版：每个窗口一行，**剩余**单独放在右侧。

```
Go 用量                                             状态正常
● 5 小时   0% 已用 · 4小时58分钟后重置              100% 剩余
● 每周    28% 已用 · 3天2小时后重置                  72% 剩余
● 每月    14% 已用 · 11月7日8点55分重置              86% 剩余
月度额度  mimo-v2.6-pro · Go $60 · Plus $120              ⓘ
```

「剩余」是百分比，不是美元数：`/usage` 每个窗口只给一个百分比、完全没有余额接口，而套餐档位也无法探测——任何美元余额都会是猜的。这一点由 ⓘ 说明。读不到配额时它明说读不到，并且不打印任何数字，而不是打一排会被当成真实读数的 `0%`。

### 输入框停靠栏计量表

计量表挂载在 `conversation.composer.dock` 中 DSH 原生 `ContextMeter` 旁。逐状态的行为说明（触发按钮的三种状态、两个面板、每一行的含义、三种「没有数字」的区别）见 [`docs/quota-meter.zh-CN.md`](./docs/quota-meter.zh-CN.md)。

```
┌─────────────────────────────────────────────────────────────────┐
│ Type a message...                                               │
│                                                                 │
│ [+] Attach                            [DeepSeek V4.1 Flash ⌄] [⬆]│
└─────────────────────────────────────────────────────────────────┘
   [ ⭕ 73% Context ]   [ ⭕ 42% Go Quota ]   ← when OpenCode Go is active
   [ ⭕ 73% Context ]   [ ⭕ $0.00 ]            ← 使用 OpenCode Zen 时
```

#### 模式 A — OpenCode Go (`opencode-go`)

- **自适应环**：实时 SVG 环，显示能回答问题的那个窗口。**已经用尽**的窗口——受限或到达上限——优先显示，从宽到窄（每月 → 每周 → 5 小时），因为月上限能解释一次拒绝，而 5 小时窗口解释不了。否则显示 **5 小时**窗口：它最早重置，是还能行动的那个。**免费模型**上环形以灰色空心显示——套餐上限与一笔无法产生的账单无关，对着 `$0.00` 亮红色会被读成"你的钱用完了"。
- **语义色**：低于 80% 为绿色（`--dsw-alias-state-success-primary`），≥80% 为琥珀色（`--dsw-alias-state-warn-primary`），达到上限为红色（`--dsw-alias-state-error-primary`）。
- **点击面板**：三行窗口，各带实时重置倒计时与一条进度条；一行会话消耗，写的是**当前选中的**模型；一行 Zen 余额；一条受限告警；以及可直接处理的链接。悬停触发器显示 `Tooltip`，**列出全部三个窗口**（`5 小时 11% · 每周 33% · 每月 16%`）——触发器只能印一个数字，而下一个问题永远是"另外两个呢？"。
- **目录里没有价格的模型显示 `—`，不是 `Free`。** 面板始终显示选择器上的模型名，即使 models.dev 还没有它的条目（目录按计划同步）——显示上一个模型的名字比显示没有价格更糟。

```
┌──────────────────────────────────────────────┐
│  OpenCode Go                          [Go Plan]│
├──────────────────────────────────────────────┤
│  • 5 hours        ███████░░░░░░░░░    42% │
│    Resets 3h 12m                             │
│  • Weekly         ███░░░░░░░░░░░░░    18% │
│    Resets 5d 8h                              │
│  • Monthly        █████████████░░░    65% │
│    Resets 22d 4h                             │
├──────────────────────────────────────────────┤
│  月度额度                                    │
│  mimo-v2.6-flash              Go $60 · Plus $120│
├──────────────────────────────────────────────┤
│  当前会话消耗                                │
│  deepseek-v4.1-flash · $0.15 / $0.6 per 1M   │
│                                        $0.42 │
│  可用 Zen 余额                               │
│  请求将自动从 Zen 余额中扣除            就绪 │
├──────────────────────────────────────────────┤
│  ⟳ 更新于 08:30            升级套餐  控制台 ›│
└──────────────────────────────────────────────┘
```

**月度额度，以及为什么它是总额而不是余额。** 三个窗口是某个模型月度**美元**额度的比例——官方原话：_"Usage limits are defined as monthly dollar amounts… 5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%."_ 所以计量表把这笔额度打印在窗口下面：`mimo-v2.6-flash` 是 `Go $60 · Plus $120`。它由官方 Go 文档生成（`pnpm run limits:shim`，CI 定时校验），因为页面明说*"usage limits may change"*——手写表一个版本内就会过期，而过期的美元数字看起来很权威。

它同时显示**两个档位**而不是只显示一个，因为档位查不到：`/limits`、`/plan`、`/subscription`、`/account`、`/credits` 全部 404，`/models` 也没有额度字段。猜一个档位，金额就会差 2–3 倍。

它**刻意不是剩余额度**。`GET /zen/go/v1/usage` 不接受 model 参数，所以返回的百分比是账号级的，而额度是按模型的——两者相乘得到的数字没有指代对象。真实余额在控制台，那里是准确的。

#### 模式 B — OpenCode Zen (`opencode`)

Zen 路线上不出现任何 Go 的数字：根本不画圆环（没有可量的量规就是装饰），标签是消费额而不是百分比，Go 套餐被限流也不会把 Zen 按钮染成告警色，悬停则带上价格（`当前会话消耗 $0.00 · 按量计费`）。Go 的窗口是关于一条本路线永不结算的套餐的事实，所以在这里不出现。

- **Zen 触发器**：标签是本会话累计花费（未计价时为 `$0.00`，计价后如 `$0.42`），且**不画圆环**——圆环是量规，而 Zen 没有可量的窗口。这个数字是唯一能拿到的真实数字：OpenCode 的 Zen 余额只能通过 console 的 server action 读取，API 密钥读不到。
- **按量计费面板**：带 `Pay-as-you-go` 徽标的头部、会话消耗行（价格开关开启时），以及一个链接——[OpenCode 控制台](https://opencode.ai/console)，标为**充值**：按量计费的人点进去就是要充钱，而充值本身没有独立的地址。

```
┌───────────────────────────────────────────────┐
│  OpenCode Zen                [Pay-as-you-go]  │
├───────────────────────────────────────────────┤
│  Session Spend                                │
│  Space Bunny Free · 免费               $0.00│
├───────────────────────────────────────────────┤
│  ⟳ 更新于 08:30                      控制台 ›│
└───────────────────────────────────────────────┘
```

**Zen 余额与溢出。** 若配置了 `OPENCODE_API_KEY`（或 `oc_sk_…`），Zen 按量计费会被自动检测。Zen 面板**不显示余额行**：该余额只能通过 console 的 server action 读取，需要浏览器会话，因此面板直接链接到 [OpenCode 控制台](https://opencode.ai/console)，而不是冻结一个无法保持最新的数字。余额行放在 **Go** 面板上——那里它回答的是一个面板真能回答的问题：超出配额的 Go 请求是否真的会从该余额扣费。

---

## ⚙ 配置参考

### 仅配置项 (`cordis.patch.yml`)

这些项存在于 schema 中，却不渲染任何控件——每一项都是字面值、标记或引用，其默认值适用于所有有文档记载的配置。它们仍可在该行的 `config` 中编辑；[`cordis.patch.yml`](./cordis.patch.yml) 是参考。

| 配置项 | 默认值 | 保留在配置中的原因 |
| :-- | :-- | :-- |
| `providers` | `opencode`, `opencode-go`, `opencode-responses`, `opencode-anthropic` | 要拦截的路由 id；必须覆盖本层声明的每一条路由 |
| `gatewayUrls` | `opencode.ai/zen` | 标记网关流量的 URL 子串；只有镜像或中继才会改它们 |
| `userAgent` | 空（= 规范 CLI UA） | 字面覆盖；默认值就是网关所期望的值 |
| `originClient` | `cli` | `x-opencode-client` 的字面值 |
| `sessionIdEnv` | `OPENCODE_SESSION_ID` | 指定一个仅当调用方提供会话 id 时才使用的环境变量名 |
| `freeModelMarker` | `free` | 模型 id 子串；`*` 强制启用回退，`''` 关闭回退 |
| `usageBaseURL` | `https://opencode.ai/zen/go/v1` | 端点覆盖；从组合中自动发现 |
| `debug` / `debugFile` | `false` / — | 诊断用 JSONL 日志，不是谁会在 UI 里调节的行为 |

```yaml
# cordis.patch.yml — the plugin's row; every key is optional.
- insert:
    - id: dsh-opencode-patch
      name: "dsh-opencode-patch"
      config:
        providers:
          - opencode
          - opencode-go
          - opencode-responses
          - opencode-anthropic
        gatewayUrls:
          - opencode.ai/zen
        sessionIdEnv: "OPENCODE_SESSION_ID"
        freeModelMarker: "free"
        usageBaseURL: "https://opencode.ai/zen/go/v1"
        keySource: "auto" # auto | request | configured
        injectUserAgent: true
        injectOriginHeaders: true
        originClient: "cli"
        injectProject: true # attach workspace folder (or 'global'); false omits the header
        injectCoreTools: true
        enrichModels: true # merge models.dev specs + active free models into listings
        usageEnabled: true
        showUsagePrice: true # session spend + active model rate in the meter
        # File-level only debug options:
        debug: false
        debugFile: "/tmp/dsh-opencode-debug.jsonl"
```

> **宿主重载规则：** 任何宿主变更（`lib/index.mjs`）之后都要重启 `dsh web`；客户端 UI 变更（`lib/client.js`）刷新浏览器即可。

---

## 🛠 故障排查

| 症状 | 可能原因 | 解决方法 |
| :-- | :-- | :-- |
| 免费模型报 `403 FreeTierError` | 网关请求头被剥离，或缺少工具定义 | 保持**恢复 User-Agent**、**注入客户端来源头**与**自动补全核心工具**开启 |
| `400 MissingSessionID` | 未附带会话请求头 | 确认 `dsh-opencode-patch` 已列入 profile 的 `dsh.profile.bundles` |
| Auto Review 报 `TRANSPORT: Connection error` | 更新后宿主进程未重启 | 停止并重启 `dsh web`，让新的 `lib/index.mjs` 加载 |
| Go 模型始终不显示额度环 | 解析不到 Go 凭据，或当前激活的网关不是 `opencode-go` | 在 DSH Credentials 中存储 `OPENCODE_GO_API_KEY`，并经 `opencode-go` 路由 |
| 目录中的模型在 Settings → Fetch 里缺失，或已下线的模型仍然存在 | 宿主模块过期、补全关闭，或适配器用自带目录作答 | `pnpm run build`、重启 `dsh web`、保持**使用 models.dev 补全模型列表**开启、从匹配的路由获取、搜索精确 id（如 `space-bunny-free`） |
| 弹出面板以红色显示“已达限额” | 滚动 / 每月窗口已用到 100% | 打开 [OpenCode 控制台](https://opencode.ai/console)并启用 _使用余额（Use balance）_，以溢出到 Zen 额度 |
| 非 OpenCode 模型行为异常 | 与本补丁无关 | 发往其他网关的流量原样通过 |

---

## 📜 兼容性与验证

**已在 DeepSeek Harness 0.2.0-rc.2（Node 24+）上验证**

| 层面 | 目标 |
| :-- | :-- |
| **插件包** | npm 上的 `dsh-opencode-patch`，外加 [`@viztor/dsh-opencode-patch`](https://www.npmjs.com/package/@viztor/dsh-opencode-patch) / [`@viztor/dsh-opencode`](https://www.npmjs.com/package/@viztor/dsh-opencode) 作用域别名 |
| **宿主 profile** | DSH Web profile（`patchReload: live`） |
| **声明的路由** | `opencode`、`opencode-go`、`opencode-responses`、`opencode-anthropic` |
| **网关** | `opencode.ai/zen/v1`（`/responses`、`/chat/completions`、`/messages`、`:streamGenerateContent`）、`zen/go/v1`（`/chat/completions`） |
| **支持的模型** | `claude-sonnet-4-5`、`gpt-5.4`、`gemini-3.8-flash`、`deepseek-v4.1-flash`、`muse-spark-1.3-contributor-free`、`qwen3.8-flash` |
| **验证关卡** | `vp check` 干净、**266** 个确定性测试全绿、完整 schema 校验、消费者安装 + 加载（[`scripts/check.ts`](./scripts/check.ts)） |

---

## 🔍 深入解析：协议规范

### 1. 请求头注入矩阵

从官方 `opencode` CLI 二进制反编译可见，网关对原生 OpenCode 路由与第三方中继强制要求不同的请求头：

```javascript
// Extracted from OpenCode CLI's HTTP request builder:
headers: {
  "x-opencode-session-id": e.sessionID,
  ...(e.parentSessionID ? { "x-opencode-parent-session-id": e.parentSessionID } : {}),
  ...(e.model.providerID.startsWith("opencode")
    ? {
        ...(k ? { "x-opencode-project": k } : {}),
        "x-opencode-session": e.sessionID,
        "x-opencode-request": e.user.id,
        "x-opencode-client": e.flags.client,
        "User-Agent": _i
      }
    : {
        "x-session-affinity": e.sessionID,
        "X-Session-Id": e.sessionID,
        "User-Agent": _i
      }),
  ...(e.parentSessionID ? { "x-parent-session-id": e.parentSessionID } : {})
}
```

fetch 补丁满足每一种变体：

| 请求头 | 值 | 用途 |
| :-- | :-- | :-- |
| `x-opencode-session` | `ses_<12hex><14base62>` | 厂商会话亲和；启用 KV 缓存提示路由 |
| `x-opencode-session-id` | `ses_<12hex><14base62>` | OpenCode CLI v1.18+ 网关所要求 |
| `x-session-affinity` | `ses_<12hex><14base62>` | 通用代理 / 中继亲和（Cloudflare AI Gateway、LiteLLM、Portkey） |
| `x-opencode-parent-session-id` | `ses_<parent_hash>` | DSH 子代理的分层谱系（`subagent`、`subagent_fork`） |
| `x-parent-session-id` | `ses_<parent_hash>` | 通用代理父会话亲和 |
| `User-Agent` | `opencode/1.18.34 …` | 避免 Cloudflare WAF Error 1010 挑战 |
| `x-opencode-client` | `cli`（可配置） | 向 Zen 网关标识客户端层级 |
| `x-opencode-project` | 动态 / `global` | 供控制台使用的工作区项目归属 |

### 2. 分层子代理与父会话谱系

当 DSH 派生子代理（`subagent` / `subagent_fork`）时，每个子代理运行在独立会话中。插件检查宿主 `SessionRegistry` 中的 `session.header.parentSession`，并通过 SHA-256 把两个会话确定性地映射起来：

```
[Parent DSH Session: "session-abc"] ──(SHA-256)──> [ses_parent_12hex14base62]
           │
           ▼ spawns subagent
[Child DSH Session:  "session-xyz"] ──(SHA-256)──> [ses_child_12hex14base62]

Outgoing subagent request:
  x-opencode-session:           ses_child_12hex14base62
  x-opencode-session-id:        ses_child_12hex14base62
  x-session-affinity:           ses_child_12hex14base62
  x-opencode-parent-session-id: ses_parent_12hex14base62
  x-parent-session-id:          ses_parent_12hex14base62
```

这一谱系让上游服务器可以跨 agent 团队与委派工作流优化提示缓存。

### 3. 动态工作区项目归属

OpenCode 使用 `x-opencode-project`，在 [OpenCode 控制台](https://opencode.ai/console)中按项目归组 Token 用量、请求数与花费。

1. **启用（默认）：** 插件读取当前会话的工作目录（`session.header.cwd`）并发送其文件夹名——`/Users/viz/dev/dsh-opencode` → `x-opencode-project: dsh-opencode`。在项目之外则回退为 `global`。
2. **关闭：** 完全不发送该请求头，与 OpenCode CLI 的独立运行行为一致。
3. **零配置：** 无需输入或维护任何项目字符串——归属自然跟随你的工作区。

### 4. DSH 实验性 Auto Review 兼容性

在实验性 **Auto Review** 模式（`@deepseek-ai/dsh-experimental-auto-review`）下，每一次工具执行都会先由一次后台模型调用来审计：

```javascript
// @deepseek-ai/dsh-experimental-auto-review
async function classifyRisk(ctx, agent, exec, signal) {
  const snapshot = snapshotAutoReview(agent, exec);
  const options = deepFreeze({
    provider: snapshot.provider,
    model: snapshot.model,
    system: REVIEW_POLICY,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: reviewUserText(snapshot) }],
      },
    ],
    temperature: 0,
    signal,
  });
  return readDecision(ctx.llm.stream(options));
}
```

由于这些调用省略了 `options.sessionId`，早期版本的插件会短路 stream 钩子，导致轮次存储为空、评审请求未经补丁直接发出（`TRANSPORT: Connection error`）。现在只要 `sessionId` 缺失，插件就会生成确定性的回退轮次状态，因此 Auto Review 的流同样能获得完整的请求头注入与免费层工具 schema。

### 5. OpenCode API 层级：V1 与 V2、Zen 与 Go

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OpenCode API surfaces                           │
├───────────────────────────────────┬────────────────────────────────────┤
│   V1 inference gateway (data)     │    V2 control-plane API (manage)   │
├───────────────────────────────────┼────────────────────────────────────┤
│ • https://opencode.ai/zen/v1      │ • https://api.opencode.ai          │
│ • https://opencode.ai/zen/go/v1   │ • Local server: @opencode/client   │
│ • Static API keys:                │ • OAuth token pairs:               │
│     - Go:  sk-… (subscription)    │     { type: "oauth",               │
│     - Zen: oc_sk_… (pay-as-you-go)│       access: "…", refresh: "…" }  │
│ • Chat completions, models, quota │ • Sessions, tools, workspaces      │
└───────────────────────────────────┴────────────────────────────────────┘
```

**凭据隔离（防止 `403 EntitlementError`）。** Go 密钥（`sk-…`）携带订阅权益，可以查询 `https://opencode.ai/zen/go/v1/usage` 获取滚动、每周与每月窗口。Zen 密钥（`oc_sk_…`）做不到——Go 端点会这样回答：

```json
403 {"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}
```

插件把二者隔离开：`resolveGoApiKey` 将 Zen 密钥排除在 Go 用量查询之外；若只存在一个 Zen 密钥，用量发现会报告 `configured: false`，额度环保持隐藏，而不是不断撞 403；`EntitlementError` 响应会被映射为 `configured: false` 或 Zen 额度状态。

**Go 套餐溢出到 Zen 额度。** 月度额度用到 100% 时，只有在 [OpenCode 控制台](https://opencode.ai/console)中为该 Go 订阅启用了 _使用余额（Use balance）_，请求才会回退到 Zen 余额。OpenCode **没有公开的余额 API**（开放的功能请求 [anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448)）；溢出由服务端处理：

```javascript
// OpenCode CLI rate limit handler:
if (e.data.responseBody?.includes("GoUsageLimitError")) {
  let y = `${f ? `${f} usage limit` : "Usage limit"} reached... To continue using this model now, enable usage from your available balance`,
    k = `https://opencode.ai/workspace/${d}/go`;
  return {
    message: `${y} - ${k}`,
    action: { label: "open settings", link: k },
  };
}
```

### 6. 对比：`dsh-opencode-patch` 与 `dsh-opencode-go`

与 Duskriver 的 [`dsh-opencode-go`](https://www.npmjs.com/package/dsh-opencode-go) 相比如何？

| 能力 | `dsh-opencode-go` | `dsh-opencode-patch`（本插件） |
| :-- | :-- | :-- |
| **定位** | 独立 Go 网关 | 通用网关补丁与增强层 |
| **拦截的路由** | 仅专用 Go 路由 | 任何已声明的路由：`opencode`、`opencode-go`、自定义中继 |
| **OpenCode Go 模型** | ✅（`/zen/go/v1`） | ✅（`/zen/go/v1`） |
| **OpenCode Zen 模型** | ❌ | ✅（`/zen/v1` — Claude、GPT-5、Gemini、contributor） |
| **多协议网关** | 仅 OpenAI Completions | Responses + Completions + Anthropic + Google |
| **免费层工具回退** | ❌ | ✅ 自动注入 `read` + `bash` schema |
| **分层子代理** | ❌ | ✅ 注入父会话请求头 |
| **动态工作区项目** | ❌ | ✅ 由 `session.header.cwd` 派生 |
| **Auto Review 支持** | ❌ 缺少 `sessionId` 时失败 | ✅ 在 `AsyncLocalStorage` 中回退捕获轮次 |
| **停靠栏计量表** | 文本字符串 | SVG 环、会话消耗、模型费率 |
| **附加 Zen 额度** | ❌ | ✅ 凭据、环境变量、自动检测 |
| **模型元数据** | `models.dev/api.json` | 标准 DSH 与 OpenCode 目录参数 |

`dsh-opencode-go` 面向只需要独立 Go 网关的用户；`dsh-opencode-patch` 则是覆盖 DSH 全部运行模式、同时修复、补全并计量 Zen 与 Go 的一体化层。（[models.dev](https://models.dev/api.json) 是两者共同引用的权威目录。）

### 7. 权威模型目录：双本地预置 + 实时 SWR 更新

OpenCode 网关的 `GET …/models` 端点经常返回截断的子集——没有显示名、上下文窗口、最大 Token 数或输入模态。插件为两个层面都提供 **stale-while-revalidate（SWR，过期重验证）**目录：

1. **双内置预置（零延迟、离线可用）：** `OPENCODE_GO_CATALOG` 携带全部 **29 个在用**的 Go 订阅模型及每百万 Token 费率，因此首次刷新之前会话计价就能工作；`OPENCODE_ZEN_CATALOG` 携带 **10 个在用免费层模型**（`muse-spark-1.3-contributor-free`、`space-bunny-free`、`fledge-alpha-free`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`、`ling-3.0-flash-fin-free`、`ling-3.1-flash-free`、`longcat-2.5-preview-free`、`mimo-v2.6-flash-free`、`big-pickle`）以及旗舰模型（`claude-sonnet-4-5`、`claude-opus-4-7`、`gpt-5.4`、`gemini-3.8-flash`、`qwen3.8-max`、`kimi-k3`）。已下线模型被排除，刷新失败也绝不会复活网关已不再提供的行——Zen 路由的三个 Muse Spark 1.2 id 被压制，付费的 Go 1.2 contributor 条目则保留（CLI 仍在列出它）。启动即时完成：没有冷启动延迟、没有阻塞式网络调用，飞行模式下也不会失败。
2. **后台重验证：** 两个目录每 **60 分钟**（OpenCode CLI 的标准周期）对照 [`https://models.dev/api.json`](https://models.dev/api.json) 重新验证一次，合并新模型、弃用项与更新后的上限。出错时优雅降级，并保留当前目录。
3. **网关 models 端点补全：** `patchFetch` 拦截 OpenCode 路由上的 `GET …/models`，并合并实时的 Go 或 Zen 目录——易读名称（`DeepSeek V4.1 Flash`、`Qwen3.8 Flash`、`Grok 4.7`、`MiMo V2.6 Pro`）、经验证的上下文窗口（最高 1,000,000+ Token）与最大输出 Token（最高 384,000）、正确的输入模态（`text`、`image`），并省略已下线的 Muse Spark 1.2 行。
4. **Settings “Fetch Available Models” 装饰：** DSH 先询问该路由自己的适配器，而对于已安装的 `opencode` 路由，`llm-pi-ai` 会直接用自带目录作答，不调用网关。因此插件对托管的发现结果做装饰：保留适配器的行及其顺序，追加缺失的规范行（如 `space-bunny-free`），移除 provider 已下线的行。这是面向设置界面的候选元数据——绝不改写已保存的路由配置。
5. **原生模型发现注册：** 在宿主运行时上，插件还会为 `opencode-go` 与 `opencode` 向 `ctx.llm.registerModelDiscovery` 注册。以上三处补全都位于 **使用 models.dev 补全模型列表** 开关之后。

### 8. 会话消耗与模型费率

位于 **显示会话消耗与模型费率** 开关之后（默认开启）：

- **按轮计价：** 每个 `llm/stream` 用量事件都用目录中执行模型的输入 / 输出 / 缓存读取费率计价，并在宿主上累计——客户端只收到数字，永远拿不到目录。
- **按对话隔离：** 计量表发送 provider + 对话 id，因此两个同时打开的会话（或一个子代理）绝不会读到彼此的合计。
- **会话中途切换模型：** 当前标签与费率跟随随后运行的模型，累计花费与已用模型列表保持不变。
- **免费层与套餐内模型**会以 `$0.00` 报告 `Go 套餐包含`，而不是给出一个误导性的费率。
- **Go 套餐花费**是基于费率的消耗_估算_，不是账单——套餐内用量已由套餐覆盖。[OpenCode 控制台](https://opencode.ai/console)仍是计费的权威来源。

### 9. 按路由模型的密钥解析与超量行为

不同模型可能路由到不同账号（企业 Go 订阅与个人 Zen 密钥并存）。`resolveRoutedKey(ctx, provider)` 检查已加载的 Cordis 行中分配给各路由的 `apiKeyEnv` / 字面 `apiKey`，从密钥前缀（`sk-…` 与 `oc_sk_…`）推导账号层级（`go` 与 `zen`），计量表据此查询：

- **OpenCode Go（`opencode-go`）：** 三个窗口（5 小时滚动、每周、每月百分比）上的固定订阅额度。达到 100% 时网关返回 `GoUsageLimitError`（HTTP 402/429）。服务端溢出到 Zen 余额，仅在该 Go 账号启用 _使用余额_（[opencode.ai/workspace/go](https://opencode.ai/workspace/go)）时才有效——_另一个_账号上的 Zen 密钥绝不会被自动扣款。
- **OpenCode Zen（`opencode`）：** 按 Token 从账号余额中按量计费；没有滚动窗口。余额为 $0.00 时网关返回 `HTTP 402 Insufficient account funds`——通过弹出面板中的控制台链接充值。

---

## 👥 署名与许可

在 [@nobu121](https://github.com/nobu121) 的 [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) 基础上演进而来，该项目开创了 OpenCode on DSH 的会话 ID 处理。由 [@viztor](https://github.com/viztor) 扩展，以支持 Zen 免费层网关兼容、分层子代理谱系、动态工作区项目归属、实时双模式 Go 额度与 Zen 余额监控，以及原生 Web UI 集成。

**链接：** [npm](https://www.npmjs.com/package/dsh-opencode-patch) · [仓库](https://github.com/viztor/dsh-opencode-patch) · [问题](https://github.com/viztor/dsh-opencode-patch/issues) · [更新日志](./CHANGELOG.md) · [贡献指南](./CONTRIBUTING.md) · [OpenCode](https://opencode.ai) · [models.dev](https://models.dev)

以 [MIT License](LICENSE) 授权。
