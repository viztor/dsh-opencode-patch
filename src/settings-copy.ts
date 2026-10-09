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
  freeModel: "Free",
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
  /**
   * The spend row is always drawn; this is what it says when the accumulator
   * holds nothing for the session. Hiding the row instead reads as "the feature
   * is gone", and the panel cannot tell that apart from "no turns yet".
   */
  sessionSpendEmpty: "No turns yet in this session",
  save: "Save",
  saveFailed: "The deployment did not accept these values.",
  saving: "Saving…",
  title: "OpenCode Patch",
  unavailable: "This plugin is not loaded, so it cannot be configured.",
  usageConsole: "Console",
  usageTopUp: "Top up",
  usageEnabled: "Enable Composer Usage Meter (default on)",
  usageEnabledHint:
    "Shows the OpenCode meter in the composer dock beside context usage: the Go quota ring, or the Zen session spend. Empty inherits default.",
  usageLastUpdated: "Last updated",
  usageLimited: "Limit reached",
  usageRefreshFailed: "Refresh failed",
  usageRefreshing: "Refreshing…",
  /**
   * The absolute shape's word, in TWO halves: a locale puts it where its own
   * grammar wants it. English reads `Resets Nov 7, 8:55 AM` (prefix, empty
   * suffix); Chinese reads `11月7日8点55分重置` (empty prefix, suffix). Word order
   * is a property of the language, so it belongs in the dictionary rather than
   * in a branch in the panel.
   */
  usageResetsAtPrefix: "Resets ",
  usageResetsAtSuffix: "",
  /**
   * The SUFFIX form, for a countdown: `1h 11m until reset`. Carries its own
   * leading space because zh does not want one (`1h 11m后重置`), and the two
   * cannot share a composition rule.
   */
  usageResetsIn: " until reset",
  /** A window whose reset instant has already passed — see `RelativeReset`. */
  usageResetPassed: "Already reset",
  /**
   * Under a minute to go. Copy rather than a duration: no locale formats "less
   * than a minute" as a number of minutes, and the old hardcoded `<1m` leaked
   * a Latin unit into the Chinese line.
   */
  usageResetUnderMinute: "<1m",
  usageRetry: "Retry now",
  usageTitle: "OpenCode Go usage",
  usageAuthRejected: "Go key rejected — check this account’s key",
  usageUnavailable: "Unavailable",
  usageUpgradePlan: "Upgrade plan",
  usageSummaryTitle: "Go usage",
  usageSummaryStatusOk: "Healthy",
  usageSummaryStatusLimited: "Limit reached",
  usageSummaryUnavailable: "Quota unavailable",
  usageSummaryUsed: "used",
  usageSummaryRemaining: "left",
  usageSummaryAllowance: "Monthly allowance",
  usageSummaryNote:
    'OpenCode publishes a percentage per window and no balance, so "left" is the complement of that same percentage — not a dollar figure. The plan tier is not discoverable either.',
  usageZenFallbackNotice:
    "When Go plan limits are reached, requests automatically fall back to Zen balance only if 'Use balance' is enabled on this Go subscription's account in the OpenCode Console. Separate Zen accounts cannot be debited for Go plan overflow.",
  /**
   * The billing-semantics note under the Zen-credit card. Deliberately makes no
   * dollar claims: the gateway decides overflow per request and publishes no
   * within-allowance vs overage split, so every figure this meter could print
   * would be an estimate wearing a precise outfit.
   */
  usageOverflowBilling:
    "Session spend is split by where each turn ran: Go plan requests bill to the Go allowance, Zen requests to the Zen balance. When the Go plan overflows, the gateway bills the overflow to Zen — OpenCode publishes no within-allowance vs overage split.",
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
  zenPaygTooltip: "Pay-as-you-go · no quota window",
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
  freeModel: "免费",
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
  sessionSpendEmpty: "本会话暂无记录",
  save: "保存",
  saveFailed: "保存失败，请检查填写内容。",
  saving: "保存中…",
  title: "OpenCode 补丁设置",
  unavailable: "插件未加载，暂无法配置。",
  usageConsole: "控制台",
  usageTopUp: "充值",
  usageEnabled: "开启输入区用量计量（默认开启）",
  usageEnabledHint:
    "在输入框停靠栏（与上下文用量并列）显示 OpenCode 用量计量：Go 额度环，或 Zen 会话消耗。留空沿用默认值。",
  usageLastUpdated: "更新于",
  usageLimited: "已达限额",
  usageRefreshFailed: "刷新失败",
  usageRefreshing: "正在刷新…",
  usageResetsAtPrefix: "",
  usageResetsAtSuffix: "重置",
  usageResetsIn: "后重置",
  usageResetPassed: "已重置",
  usageResetUnderMinute: "<1分",
  usageRetry: "立即重试",
  usageTitle: "OpenCode Go 用量",
  usageAuthRejected: "Go 密钥被拒 — 请检查该账号的 Go key",
  usageUnavailable: "暂不可用",
  usageUpgradePlan: "升级套餐",
  usageSummaryTitle: "Go 用量",
  usageSummaryStatusOk: "状态正常",
  usageSummaryStatusLimited: "已达限额",
  usageSummaryUnavailable: "读不到配额",
  usageSummaryUsed: "已用",
  usageSummaryRemaining: "剩余",
  usageSummaryAllowance: "月度额度",
  usageSummaryNote:
    "OpenCode 每个窗口只提供百分比、没有余额接口，所以「剩余」是同一百分比的反面，而不是美元数；套餐档位也无法探测。",
  usageZenFallbackNotice:
    "当 Go 套餐额度用尽时，仅在当前 Go 订阅账号的控制台中开启了「使用余额 (Use balance)」时才会自动回退；独立账号的 Zen 余额无法跨账号自动承接。",
  usageOverflowBilling:
    "本会话消耗按轮次归属：Go 套餐请求计入 Go 额度，Zen 请求计入 Zen 余额。Go 套餐溢出时由网关把溢出部分计入 Zen 余额——OpenCode 不提供「额度内 / 溢出」的拆分数据。",
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
  zenPaygTooltip: "按量计费 · 无额度窗口",
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
