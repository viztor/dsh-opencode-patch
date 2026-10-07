/**
 * Locale dictionaries for the OpenCode Patch card and quota meter. `zh` is typed
 * against `en`'s key set, so a missing translation fails typecheck instead of
 * surfacing as a raw key in the UI.
 *
 * @module dsh-opencode-patch/settings-copy
 */

export const en = {
  description:
    "OpenCode Zen gateway origin headers, session affinity, free-tier compatibility, and live Go quota display.",
  enrichModels: "Enrich Models from Models.dev (default on)",
  enrichModelsHint:
    "Merges canonical specifications, active free models, and accurate context limits from models.dev into OpenCode model listings. Turn off to keep raw gateway listings.",
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
  groupModels: "Models & Free Tier",
  groupQuota: "Quota Meter",
  groupRequests: "Gateway Requests",
  freeModel: "no extra charge",
  invalidText: "This value was not accepted; leave blank for default.",
  keySource: "Credential Source",
  keySourceAuto: "Automatic",
  keySourceConfigured: "Declared key first",
  keySourceHint:
    "Which key wins when several resolve. Automatic takes the declared key, then one captured from a live request; the other two promote one side.",
  keySourceRequest: "Live request first",
  overridden: "Overridden",
  readOnly: "This deployment stores settings read-only.",
  reset: "Reset to default",
  sessionSpend: "Session Spend",
  save: "Save",
  saveFailed: "The deployment did not accept these values.",
  saving: "Saving…",
  title: "OpenCode Patch",
  unavailable: "This plugin is not loaded, so it cannot be configured.",
  usageConsole: "Console",
  usageTopUp: "Top up",
  usageEnabled: "Enable Go Quota Monitor (default on)",
  usageEnabledHint:
    "Displays live OpenCode Go quota ring in the composer dock beside context usage. Empty inherits default.",
  usageLastUpdated: "Last updated",
  usageLimited: "Limit reached",
  usageLoading: "Loading usage…",
  showUsagePrice: "Show Session Spend & Model Rate (default on)",
  showUsagePriceHint:
    "Shows accumulated session cost and the active model's per-million-token rate in the meter, priced from models.dev. Turn off to show quota only.",
  usageRefreshFailed: "Refresh failed",
  usageRefreshing: "Refreshing…",
  usageResets: "Resets",
  usageRetry: "Retry now",
  usageTitle: "OpenCode Go usage",
  usageAuthRejected: "Go key rejected — check this account’s key",
  usageUnavailable: "Unavailable",
  usageUpgradePlan: "Upgrade plan",
  usageZenFallbackNotice:
    "When Go plan limits are reached, requests automatically fall back to Zen balance only if 'Use balance' is enabled on this Go subscription's account in the OpenCode Console. Separate Zen accounts cannot be debited for Go plan overflow.",
  usage_monthly: "Monthly",
  usage_rolling: "5 hours",
  usage_weekly: "Weekly",
  zenCredit: "Available Zen Balance",
  zenFallbackNotice: "Requests will automatically consume Zen balance",
  zenOverflowActive: "Zen balance ready for overflow",
  zenPaygBadge: "Pay-as-you-go",
  goPlanTitle: "OpenCode Go",
  goPlusTier: "Plus",
  goTier: "Go",
  monthlyAllowance: "Monthly allowance",
  zenPaygTitle: "OpenCode Zen",
};

/** `zh` mirrors `en` key-for-key; the type makes a missing key a compile error. */
export const zh: Record<keyof typeof en, string> = {
  description:
    "OpenCode Zen 网关来源头恢复、会话保持、免费模型兼容与 Go 实时额度显示。",
  enrichModels: "使用 models.dev 补全模型列表（默认开启）",
  enrichModelsHint:
    "将 models.dev 的规范参数、当前免费模型与准确的上下文上限合并进 OpenCode 模型列表。关闭后保留网关原始列表。",
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
  groupModels: "模型与免费额度",
  groupQuota: "配额计量",
  groupRequests: "网关请求",
  freeModel: "不额外计费",
  invalidText: "该值未被接受，留空使用默认值。",
  keySource: "凭据来源",
  keySourceAuto: "自动",
  keySourceConfigured: "优先已声明密钥",
  keySourceHint:
    "多个来源都可用时以哪个为准。自动先取已声明密钥、再取捕获密钥；另两项各优先一侧。",
  keySourceRequest: "优先实时请求",
  overridden: "已覆盖",
  readOnly: "当前部署配置为只读。",
  reset: "恢复默认",
  sessionSpend: "当前会话消耗",
  save: "保存",
  saveFailed: "保存失败，请检查填写内容。",
  saving: "保存中…",
  title: "OpenCode 补丁设置",
  unavailable: "插件未加载，暂无法配置。",
  usageConsole: "控制台",
  usageTopUp: "充值",
  usageEnabled: "开启 OpenCode Go 额度监控（默认开启）",
  usageEnabledHint:
    "在输入框底部停靠栏（与上下文用量并列）显示实时额度环。留空沿用默认值。",
  usageLastUpdated: "更新于",
  usageLimited: "已达限额",
  usageLoading: "正在读取用量…",
  showUsagePrice: "显示会话消耗与模型费率（默认开启）",
  showUsagePriceHint:
    "在额度表中显示本会话累计花费与当前模型每百万 Token 费率（取自 models.dev）。关闭后仅显示额度。",
  usageRefreshFailed: "刷新失败",
  usageRefreshing: "正在刷新…",
  usageResets: "重置于",
  usageRetry: "立即重试",
  usageTitle: "OpenCode Go 用量",
  usageAuthRejected: "Go 密钥被拒 — 请检查该账号的 Go key",
  usageUnavailable: "暂不可用",
  usageUpgradePlan: "升级套餐",
  usageZenFallbackNotice:
    "当 Go 套餐额度用尽时，仅在当前 Go 订阅账号的控制台中开启了「使用余额 (Use balance)」时才会自动回退；独立账号的 Zen 余额无法跨账号自动承接。",
  usage_monthly: "每月",
  usage_rolling: "5 小时",
  usage_weekly: "每周",
  zenCredit: "可用 Zen 余额",
  zenFallbackNotice: "请求将自动从 Zen 余额中扣除",
  zenOverflowActive: "Zen 余额已就绪，将在额度用尽时自动承接",
  zenPaygBadge: "按量计费",
  goPlanTitle: "OpenCode Go",
  goPlusTier: "Plus",
  goTier: "Go",
  monthlyAllowance: "月度额度",
  zenPaygTitle: "OpenCode Zen",
};

/** Renders a copy key for the card's `t` prop. */
export type Translate = (key: keyof typeof en) => string;

/**
 * Every copy key the dictionaries define.
 *
 * Exported so the field register (`settings-fields.ts`) can type its
 * `labelKey` / `hintKey` against it: a field whose copy was never written is
 * then a compile error rather than a raw key in the UI.
 */
export type CopyKey = keyof typeof en;
