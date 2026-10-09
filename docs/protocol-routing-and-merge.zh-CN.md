# 协议路由、目录合并与界面

这个插件做三件事：让 OpenCode 的每个模型都发到它**实际被服务**的那个 API 上；把来自多个来源的模型目录合并成一份可用的清单；在输入框旁和设置页里把额度讲清楚。

计量表逐状态的行为见 [`quota-meter.zh-CN.md`](./quota-meter.zh-CN.md)；每个决策背后的取舍记在 `AGENTS.md`。

## 一、为什么需要路由

OpenCode 的模型分布在**三种线路形状**上，而"某个模型在哪种形状上"是**模型自己的属性**，不是账号的属性。2026-10-05 对 116 个 `opencode` 模型实测：

| 线路形状 | 端点 | 哪些模型 | 目录里的信号 |
| :-- | :-- | :-- | :-- |
| OpenAI **Chat Completions** | `POST /zen/v1/chat/completions` | **默认**——116 个里的 53 个 | 模型**不声明** SDK |
| OpenAI **Responses** | `POST /zen/v1/responses` | 32 个 | `@ai-sdk/openai` |
| Anthropic **Messages** | `POST /zen/v1/messages` | 23 个 | `@ai-sdk/anthropic` |

**"OpenAI" 占了三种里的两种。** Chat Completions 与 Responses 是**两种不同的线路格式**，需要 Responses 的模型在 completions 端点上不工作。默认那种也不是 "OpenAI"——它是路由自己注册时用的那个 api，不声明 SDK 的模型说的就是它。

DSH 按 provider 行上声明的协议选传输方式。如果这个协议不是该模型被服务的那一个，网关**不会回退**——它直接返回 `500`。所以插件的职责就是：把每个模型发到它自己的 SDK 所指的那个端点，并且**不需要用户配置任何东西**。

还有第四个 SDK 是**故意不服务**的：8 个模型声明 `@ai-sdk/google`，而 `llm-pi-ai` 没有实现该协议——没有路由可以派发，于是它们继续在 completions 路由上失败，而不是被送到一个凭空发明的地方。

## 二、路由是怎么定下来的

三步，全部由数据驱动：

1. **目录里带着 SDK。** `src/catalog-data.ts` 的每一行都有 `provider_npm`（`@ai-sdk/openai`、`@ai-sdk/anthropic`…），由 `scripts/regenerate-catalog-shim.ts` 从 models.dev 生成。
2. **SDK 对应一个协议。** 唯一的映射表在 `src/responses-routes.ts`：

   ```ts
   const PROTOCOL_FOR_SDK = {
     "@ai-sdk/openai": "openai-responses",
     "@ai-sdk/anthropic": "anthropic-messages",
   };
   ```

3. **协议对应一个路由。** `internalRouteFor(provider, model, providerNpm)` 给出服务该模型的路由（`opencode-responses` / `opencode-anthropic`），且只对本插件声明接管的 `COMPLETIONS_ROUTES` 生效；其他一律返回 `undefined`，原样放行。

随后 `src/responses-provider.ts` 在**隔离的认证作用域**下挂载宿主自己的 `llm-pi-ai` 来服务这些路由。这是全仓最难伺候的一块（要同时满足宿主四份契约），动它之前先读它的文件头注释。路由由插件注册，用户无需配置。

### 为什么是一张表，而不是一份模型名单

早期版本维护过一份"哪些模型要重定向"的手写名单。名单里被手改错的一个字段，让九个模型在**每次冷启动**时都被发错端点。厂商自己发布的 SDK 才是权威，而它随目录一起来。

### 只有端到端测试才是真的检验

`test/e2e/protocol-routing.e2e.ts` 直接问网关：每个已发布的模型，哪个端点认得它。单元测试读的就是它们要验证的那张映射表，所以**抓不到映射过期**——只有真实网关能。真正钉住路由的是"错误端点返回 `500`"这一格；`403 FreeTierError` 只能证明网关解析了模型。

## 三、目录是怎么合并的

四个来源，按固定顺序，因为它们回答的是不同的问题：

| 来源 | 回答 | 何时 |
| :-- | :-- | :-- |
| `src/catalog-data.ts`（内置 shim） | "一次网络请求都还没有时，我能提供什么？" | 冷启动、离线 |
| models.dev | "这个模型的规范参数、价格和显示名是什么？" | SWR 刷新 |
| 网关 `/models` | "**这个账号**实际能用什么？" | 每次列表请求 |
| `models-discovery.ts` | "`discoverModels` 该回答什么？" | 每次发现调用 |

**合并是增量式的，而且不会丢掉一个它解释不了的模型。** 适配器给的行一律保留；规范行只在缺失时追加；只有当**按 provider 记录的退役名单**点名某个模型时才省略它——那是事实，不是猜测。显示名和价格取自 models.dev，因为网关列表只给 id，别的几乎没有。

有两条性质比"完整"更重要：

- **冷启动永远不为空。** 内置 shim 在第一次刷新之前就能回答，选择器立刻有模型可选。刷新是**替换**整个集合，不是再追加一遍。
- **没有价格本身就是一个答案。** models.dev 里没有这个模型时，计量表显示模型名、费率显示 `—`，而不是 `Free`；面板也**绝不会**退回去描述上一个模型。

两个生成文件都在 CI 里校验：`catalog:shim` 与 `limits:shim` 在厂商数据变动时以非零码退出——这是唯一能发现"models.dev 在你背后变了"的办法。重新生成它们是**三步部署**：重新生成、重建 bundle、两者一起提交（宿主机加载的是 `lib/index.mjs`，不是 `src/`）。

## 四、界面

两个界面，同一个读数。两者都是纯视图，由 `settings-page.tsx` 提供数据——store、插槽注册和宿主远程调用都归它管。

### 输入框旁的计量表

- `src/usage-pill.tsx` —— 状态：按 provider 决定是否渲染、轮询循环、悬停/点击关闭、重试。它通过 `ctx.inject(['slots', 'modelDirectories'], …)` 注册，这是宿主自己的写法；直接从根上下文读这两个服务会**静默失败**——计量表当初就是这样坏着发布的。
- `src/usage-panel.tsx` —— `UsageTrigger`（圆环）与 `UsagePanel`（各行）。两者都是**无 hook 的纯函数**，所以测试可以直接调用并遍历元素树。
- `src/usage-ui.ts` —— 无依赖的逻辑与样式表：窗口几何、影响窗口的判定、`describeUsage` 文案、`formatRelativeReset`。

**触发按钮显示哪个窗口。** **已经用尽**的窗口（受限或到达上限）优先，从宽到窄——每月 → 每周 → 5 小时——因为月上限能解释一次拒绝，而 5 小时窗口解释不了。都没有用尽时显示 **5 小时**窗口，它最早重置。**瓶颈不是最大的那个数字，而是最小的那个还能拒绝你的窗口。**

**两个余额，绝不混为一个。** 每一轮按**实际服务它的**那一边归属（`catalogPlaneForRoute`），累加器分开保存 `costGo` / `costZen`；`attachSession` 把"这次读数属于哪个余额"投影到快照上，于是每个面板只回答自己那一边。Zen 路线上不出现任何 Go 数字：空心环、标签是消费额、Go 套餐被限流也不会把 Zen 按钮染成告警色。

### 设置卡片

`src/settings-card.tsx` 按 `CARD_FIELDS` 注册表逐条渲染控件——是注册表，不是 JSX 堆叠；`src/settings-usage.tsx` 在控件上方加一份 Go 用量摘要：每个窗口一行，**剩余**放在右侧。"剩余"是百分比，绝不是美元数：`/usage` 每个窗口只给百分比、没有余额接口，套餐档位也无法探测。这一点由 ⓘ 说明。读不到配额时不打印任何数字。

卡片的 `inject()` 以和计量表相同的方式交出 `readUsage` 与 `getLocale`，因此凭据解析和端点只有**一个**归属方。

## 五、代码在哪

| 关注点 | 模块 |
| :-- | :-- |
| 模型该发到哪个端点 | `responses-routes.ts` |
| 服务那个端点 | `responses-provider.ts` |
| 目录合并 | `models-catalog.ts`、`models-discovery.ts`、`catalog-data.ts` |
| 额度表 | `go-limits-data.ts`（生成） |
| 凭据与 `/usage` 端点 | `go-discovery.ts`、`key-capture.ts` |
| 用量宿主服务 | `usage.ts`、`usage-contract.ts` |
| 计量表状态 / 视图 / 逻辑 | `usage-pill.tsx`、`usage-panel.tsx`、`usage-ui.ts` |
| 设置卡片与摘要 | `settings-card.tsx`、`settings-usage.tsx` |
