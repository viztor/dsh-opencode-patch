# 深入解析：协议规范

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
