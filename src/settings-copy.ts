/**
 * Locale dictionaries for the OpenCode Patch card and quota meter.
 *
 * Kept out of `settings-page.tsx` so the copy reads as data and the page
 * module stays about wiring. Both dictionaries are flat `key -> string`
 * maps: `zh` is typed against `en`'s key set, so a key added to one but
 * forgotten in the other fails typecheck instead of surfacing as a raw
 * key in the UI.
 *
 * @module dsh-opencode-patch/settings-copy
 */

export const en = {
  activeModelRate: "Model Rate",
  description:
    "OpenCode Zen gateway origin headers, session affinity, free-tier compatibility, and live Go quota display.",
  enrichModels: "Enrich Models from Models.dev (default on)",
  enrichModelsHint:
    "Merges canonical specifications, active free models, and accurate context limits from models.dev into OpenCode model listings. Turn off to keep raw gateway listings.",
  freeModelMarker: "Free-Tier Model Marker (default free)",
  freeModelMarkerHint:
    "Model-id substring that triggers the core-tool fallback; * matches every model. Empty inherits the default.",
  gatewayUrls: "Gateway URL Markers",
  gatewayUrlsHint:
    "Comma-separated URL substrings matched before providers to flag OpenCode gateway traffic. Default: opencode.ai/zen.",
  injectCoreTools: "Inject Core Tools (default on)",
  injectCoreToolsHint:
    "Auto-injects read and bash tool schemas on free-tier requests to satisfy gateway validation. Empty inherits the default.",
  injectOriginHeaders: "Inject Origin Headers (default on)",
  injectOriginHeadersHint:
    "Injects official x-opencode-client origin header. Empty inherits the default.",
  injectProject: "Attach Workspace Project (default on)",
  injectProjectHint:
    "Automatically tags requests with your current workspace folder name (or 'global' if outside a project) for OpenCode Console tracking. Turn off to omit.",
  injectUserAgent: "Inject User-Agent (default on)",
  injectUserAgentHint:
    "Restores the opencode CLI User-Agent stripped by the DSH LLM adapter. Empty inherits the default.",
  includedInPlan: "Included in Go Plan",
  invalidBoolean: "Enter true or false, or leave blank for default.",
  invalidText: "This value was not accepted; leave blank for default.",
  originClient: "x-opencode-client Value (default cli)",
  originClientHint:
    "Value restored into the x-opencode-client header on gateway requests. Empty inherits the default.",
  overridden: "Overridden",
  providers: "Providers",
  providersHint:
    "Comma-separated list of route IDs to intercept. Default: opencode, opencode-go.",
  readOnly: "This deployment stores settings read-only.",
  reset: "Reset to default",
  sessionSpend: "Session Spend",
  save: "Save",
  saveFailed: "The deployment did not accept these values.",
  saving: "Saving…",
  sessionIdEnv: "Fallback Session Env Var (default OPENCODE_SESSION_ID)",
  sessionIdEnvHint:
    "Environment variable consulted for the fallback session id outside a live turn. Empty inherits the default.",
  title: "OpenCode Patch",
  unavailable: "This plugin is not loaded, so it cannot be configured.",
  usageBaseURL: "Go Usage Base URL",
  usageBaseURLHint:
    "Endpoint for Go quota statistics. Leave blank for default (https://opencode.ai/zen/go/v1) or auto-discovered URL.",
  usageConsole: "Console & balance",
  usageEnabled: "Enable Go Quota Monitor (default on)",
  usageEnabledHint:
    "Displays live OpenCode Go quota ring in the composer dock beside context usage. Empty inherits default.",
  usageHint: "Account usage · used percentage · refreshes every minute",
  usageKeyEnv: "Go Key Env Var / Credential",
  usageKeyEnvHint:
    "Reference to API key in DSH credentials or environment. Leave blank for default (OPENCODE_GO_API_KEY) or auto-discovery.",
  usageLastUpdated: "Last updated",
  usageLimited: "Limit reached",
  usageLimitedShort: "limited",
  usageLimitsDoc: "Usage limits",
  usageLoading: "Loading usage…",
  usageProviderMarkers: "Quota Meter Provider Markers",
  usageProviderMarkersHint:
    "Comma-separated provider-route markers that show the quota meter. Default: opencode-go.",
  showUsagePrice: "Show Session Spend & Model Rate (default on)",
  showUsagePriceHint:
    "Shows accumulated session cost and the active model's per-million-token rate in the meter, priced from models.dev. Turn off to show quota only.",
  usageRefreshFailed: "Refresh failed",
  usageRefreshing: "Refreshing…",
  usageResets: "Resets",
  usageRetry: "Retry now",
  usageRollingShort: "5h",
  usageStaleHint:
    "Showing the last successful usage reading. Current usage may have changed.",
  usageStaleShort: "Last data",
  usageTitle: "OpenCode Go usage",
  usageUnavailable: "Unavailable",
  usageUpgradePlan: "Upgrade plan",
  usageWeekShort: "week",
  usageZenFallbackNotice:
    "When Go plan limits are reached, requests automatically fall back to Zen balance only if 'Use balance' is enabled on this Go subscription's account in the OpenCode Console. Separate Zen accounts cannot be debited for Go plan overflow.",
  usage_monthly: "Monthly",
  usage_rolling: "5 hours",
  usage_weekly: "Weekly",
  userAgent: "User-Agent Override",
  userAgentHint:
    "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI string.",
  zenCredit: "Available Zen Balance",
  zenFallbackNotice: "Requests will automatically consume Zen balance",
  zenOverflowActive: "Zen balance ready for overflow",
  zenPaygBadge: "Pay-as-you-go",
  zenPaygDesc: "Per-token pay-as-you-go inference",
  zenPaygTitle: "OpenCode Zen",
};

/** `zh` mirrors `en` key-for-key; the type makes a missing key a compile error. */
export const zh: Record<keyof typeof en, string> = {
  activeModelRate: "当前模型费率",
  description:
    "OpenCode Zen 网关来源头恢复、会话保持、免费模型兼容与 Go 实时额度显示。",
  enrichModels: "使用 models.dev 补全模型列表（默认开启）",
  enrichModelsHint:
    "将 models.dev 的规范参数、当前免费模型与准确的上下文上限合并进 OpenCode 模型列表。关闭后保留网关原始列表。",
  freeModelMarker: "免费档模型标记（默认 free）",
  freeModelMarkerHint:
    "触发核心工具补全的模型 ID 子串；* 匹配全部模型。留空沿用默认值。",
  gatewayUrls: "网关地址标记",
  gatewayUrlsHint:
    "逗号分隔的 URL 子串，先于提供方匹配以识别 OpenCode 网关流量。默认：opencode.ai/zen。",
  injectCoreTools: "自动补全核心工具（默认开启）",
  injectCoreToolsHint:
    "在免费模型请求中自动注入 read 和 bash 工具声明以满足网关校验。留空沿用默认值。",
  injectOriginHeaders: "注入客户端来源头（默认开启）",
  injectOriginHeadersHint:
    "在网关请求中附带官方 x-opencode-client 标识头。留空沿用默认值。",
  injectProject: "附带工作区项目标识（默认开启）",
  injectProjectHint:
    "在请求中自动附带当前工作区目录名称（若在工作区外则为 'global'），便于在 OpenCode 控制台按项目统计用量。关闭后则不发送该请求头。",
  injectUserAgent: "恢复 User-Agent（默认开启）",
  injectUserAgentHint:
    "恢复被 DSH 适配器过滤掉的官方 OpenCode CLI User-Agent。留空沿用默认值。",
  includedInPlan: "Go 套餐包含",
  invalidBoolean: "请输入 true 或 false，留空使用默认值。",
  invalidText: "该值未被接受，留空使用默认值。",
  originClient: "x-opencode-client 取值（默认 cli）",
  originClientHint: "恢复到 x-opencode-client 头部的取值。留空沿用默认值。",
  overridden: "已覆盖",
  providers: "生效提供方",
  providersHint: "逗号分隔的提供方路由 ID 列表。默认：opencode, opencode-go。",
  readOnly: "当前部署配置为只读。",
  reset: "恢复默认",
  sessionSpend: "当前会话消耗",
  save: "保存",
  saveFailed: "保存失败，请检查填写内容。",
  saving: "保存中…",
  sessionIdEnv: "兜底会话环境变量（默认 OPENCODE_SESSION_ID）",
  sessionIdEnvHint:
    "在非实时回合之外查询兜底会话 ID 所用的环境变量名。留空沿用默认值。",
  title: "OpenCode 补丁设置",
  unavailable: "插件未加载，暂无法配置。",
  usageBaseURL: "Go 用量接口 Base URL",
  usageBaseURLHint:
    "查询 OpenCode Go 额度的接口地址。留空则沿用默认值（https://opencode.ai/zen/go/v1）或自动探测。",
  usageConsole: "控制台与余额",
  usageEnabled: "开启 OpenCode Go 额度监控（默认开启）",
  usageEnabledHint:
    "在输入框底部停靠栏（与上下文用量并列）显示实时额度环。留空沿用默认值。",
  usageHint: "账号额度 · 已用百分比 · 每分钟刷新",
  usageKeyEnv: "Go Key 环境变量 / 凭据引用",
  usageKeyEnvHint:
    "DSH 凭据或环境变量中存储 API Key 的引用名。留空则自动探测或沿用默认值（OPENCODE_GO_API_KEY）。",
  usageLastUpdated: "更新于",
  usageLimited: "已达限额",
  usageLimitedShort: "受限",
  usageLimitsDoc: "额度说明",
  usageLoading: "正在读取用量…",
  usageProviderMarkers: "额度表提供方标记",
  usageProviderMarkersHint:
    "逗号分隔的提供方路由标记，命中后显示额度表。默认：opencode-go。",
  showUsagePrice: "显示会话消耗与模型费率（默认开启）",
  showUsagePriceHint:
    "在额度表中显示本会话累计花费与当前模型每百万 Token 费率（取自 models.dev）。关闭后仅显示额度。",
  usageRefreshFailed: "刷新失败",
  usageRefreshing: "正在刷新…",
  usageResets: "重置于",
  usageRetry: "立即重试",
  usageRollingShort: "5小时",
  usageStaleHint: "当前显示上次成功读取的用量，实际用量可能已变化。",
  usageStaleShort: "上次数据",
  usageTitle: "OpenCode Go 用量",
  usageUnavailable: "暂不可用",
  usageUpgradePlan: "升级套餐",
  usageWeekShort: "周",
  usageZenFallbackNotice:
    "当 Go 套餐额度用尽时，仅在当前 Go 订阅账号的控制台中开启了「使用余额 (Use balance)」时才会自动回退；独立账号的 Zen 余额无法跨账号自动承接。",
  usage_monthly: "每月",
  usage_rolling: "5 小时",
  usage_weekly: "每周",
  userAgent: "自定义 User-Agent",
  userAgentHint: "自定义 User-Agent 字符串。留空则使用默认 OpenCode CLI 标识。",
  zenCredit: "可用 Zen 余额",
  zenFallbackNotice: "请求将自动从 Zen 余额中扣除",
  zenOverflowActive: "Zen 余额已就绪，将在额度用尽时自动承接",
  zenPaygBadge: "按量计费",
  zenPaygDesc: "按 Token 实际用量计费",
  zenPaygTitle: "OpenCode Zen",
};

/** Renders a copy key for the card's `t` prop. */
export type Translate = (key: keyof typeof en) => string;
