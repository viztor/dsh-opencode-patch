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
  enrichModels: "Enrich listings from the OpenCode catalog (default on)",
  enrichModelsHint:
    "Lets the gateway's /models listing carry the full OpenCode catalog (models.opencode.ai — the same registry models.dev serves) with names, context limits and modalities, and offers that catalog to Settings' model discovery. It does NOT add models to the picker — the picker shows only what you declared; use \"Check catalog\" above for that. A declared model's own info (context, modalities, thinking levels) always comes from your model row and the catalog, whatever this says. Off leaves the gateway listing as the gateway sent it and offers no catalog to discovery.",
  endpoint: "API Endpoint",
  endpointAuto: "Automatic (same as Modern)",
  endpointHint:
    "Which endpoint family requests are sent to. Modern sends each protocol to its own inference path (inference/openai, inference/anthropic, inference/google; inference/go/… on Go); Automatic is the same as Modern; Legacy pins the older zen/v1 base (zen/go/v1 on Go). The two families are separately entitled and both still answer, so pick whichever your account works on.",
  endpointLegacy: "Legacy (zen/v1)",
  endpointModern: "Modern (inference, per protocol)",
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
  groupAccess: "Account & Endpoint",
  groupModels: "Models & Free Tier",
  groupQuota: "Quota Meter",
  groupRequests: "Gateway Requests",
  freeModel: "Free",
  invalidText: "This value was not accepted; leave blank for default.",
  keySource: "Credential Source",
  keySourceAuto: "Automatic",
  keySourceConfigured: "Declared key first",
  keySourceHint:
    "Which key wins when several resolve. Automatic takes a literal key, then one captured from a live request, then the declared reference; Declared key first puts the reference ahead of the captured key, Live request first puts captured keys first.",
  keySourceRequest: "Live request first",
  readOpencodeStore: "Read the OpenCode installation's key (default off)",
  readOpencodeStoreHint:
    "Uses the credential OpenCode itself stored, as the LAST resort: a key you declared here or exported always wins. Off by default — turn it on to let this plugin read another tool's credential store.",
  storeInspect: "Check this machine",
  storeInspectBusy: "Checking…",
  storeInspectTitle: "Local OpenCode installation",
  storeInspectHint:
    "Reads the credential store the OpenCode CLI on this machine already holds and reports which account it belongs to. It never displays or transmits the secret itself.",
  storeInspectFound: "Found",
  storeInspectMissing: "No local OpenCode store was found on this machine.",
  storeInspectNoAccount:
    "The store exists but holds no OpenCode account credential.",
  storeInspectUnavailable: "This host mounted no inspection service.",
  storeInspectFailed: "The check failed",
  storeInspectAccount: "Account",
  storeInspectOrg: "Organization",
  storeInspectKind: "Credential",
  storeInspectKindOauth: "OAuth session",
  storeInspectKindKey: "API key",
  storeInspectKindUnknown: "Unknown",
  storeInspectExpires: "Expires",
  storeInspectExpired: "expired",
  storeInspectRefreshable: "expired — renews on next use",
  storeInspectValid: "valid",
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
  purgeTitle: "Purge deprecated models",
  purgeHint:
    "Deletes the model entries this deployment declares that the live catalog has retired. It rewrites the provider list in your profile — nothing is filtered at read time, so what the picker shows is exactly what you declared.",
  purgeAction: "Purge",
  purgeBusy: "Purging…",
  purgeRemoved:
    "reference(s) to retired models removed from your configuration",
  purgeNothing:
    "Nothing to purge — the catalog reports no retired model in your list.",
  purgeCatalogUnread:
    "Nothing removed, but the catalog could not be read — try again when online.",
  purgeUnavailable: "Unavailable: this composition has no config editor.",
  purgeFailed: "Purge failed",
  usageSummaryTitle: "Go usage",
  usageSummaryStatusOk: "Healthy",
  usageSummaryStatusLimited: "Limit reached",
  loginAction: "Sign in to OpenCode",
  loginAgain: "Sign in again",
  loginExpired: "The code expired",
  loginFailed: "Sign-in failed",
  loginSignedIn: "Signed in",
  loginSignedOut: "Not signed in",
  loginPlane: "Sign in to",
  loginPlaneGo: "Go (subscription)",
  loginPlaneZen: "Zen (pay-as-you-go)",
  loginTitle: "OpenCode account",
  loginWaiting: "Waiting for approval…",
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
  enrichModels: "用 OpenCode 官方目录补全列表（默认开启）",
  enrichModelsHint:
    "让网关 /models 列表带上 OpenCode 官方目录（models.opencode.ai，与 models.dev 是同一份注册表）里的完整目录，含名称、上下文上限与模态，并把这份目录提供给设置页的模型发现。它不会往选择器里添加模型——选择器只显示你声明的那些，要添加请用上面的「检查目录」。已声明模型自身的信息（上下文、模态、思考档位）始终来自你的模型行与目录，与此开关无关。关闭后网关列表保持原样，也不向模型发现提供目录。",
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
  groupAccess: "账户与端点",
  groupModels: "模型与免费额度",
  groupQuota: "配额计量",
  groupRequests: "网关请求",
  endpoint: "API 端点",
  endpointAuto: "自动（同新端点）",
  endpointHint:
    "请求发往哪个端点家族。新端点按协议各自发往 inference 路径（inference/openai、inference/anthropic、inference/google；Go 为 inference/go/…）；自动与新端点相同；旧端点固定使用较早的 zen/v1（Go 为 zen/go/v1）。两套端点的授权彼此独立且目前均可访问，因此请选择账户可用的那个。",
  endpointLegacy: "旧端点（zen/v1）",
  endpointModern: "新端点（inference，按协议）",
  freeModel: "免费",
  invalidText: "该值未被接受，留空使用默认值。",
  keySource: "凭据来源",
  keySourceAuto: "自动",
  keySourceConfigured: "优先已声明密钥",
  keySourceHint:
    "多个来源都可用时以哪个为准。自动先取字面密钥，再取实时请求捕获的密钥，最后取声明的引用；优先已声明密钥把引用排在捕获密钥之前，优先实时请求把捕获密钥排在最前。",
  keySourceRequest: "优先实时请求",
  readOpencodeStore: "读取 OpenCode 安装的密钥（默认关闭）",
  readOpencodeStoreHint:
    "使用 OpenCode 自己保存的凭据，且仅作为最后兜底：你在此声明或导出的密钥始终优先。默认关闭——开启后本插件才会读取另一个工具的凭据库。",
  storeInspect: "检测本机",
  storeInspectBusy: "检测中…",
  storeInspectTitle: "本机 OpenCode 安装",
  storeInspectHint:
    "读取本机 OpenCode CLI 已保存的凭据库，并报告它属于哪个账号。密钥本身既不会显示，也不会外传。",
  storeInspectFound: "已找到",
  storeInspectMissing: "本机没有找到 OpenCode 的凭据库。",
  storeInspectNoAccount: "凭据库存在，但其中没有 OpenCode 账号凭据。",
  storeInspectUnavailable: "当前宿主未挂载检测服务。",
  storeInspectFailed: "检测失败",
  storeInspectAccount: "账号",
  storeInspectOrg: "组织",
  storeInspectKind: "凭据类型",
  storeInspectKindOauth: "OAuth 会话",
  storeInspectKindKey: "API 密钥",
  storeInspectKindUnknown: "未知",
  storeInspectExpires: "有效期至",
  storeInspectExpired: "已过期",
  storeInspectRefreshable: "已过期（下次使用自动续期）",
  storeInspectValid: "有效",
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
  purgeTitle: "清理已废弃模型",
  purgeHint:
    "删除本部署声明过、但线上目录已下架的模型条目。它会重写你 profile 里的 provider 列表——读取时不做任何过滤，所以选择器显示的就是你真正声明的。",
  purgeAction: "清理",
  purgeBusy: "清理中…",
  purgeRemoved: "处已下架的模型引用已从配置中移除",
  purgeNothing: "没有可清理的内容——目录显示你的声明与引用里都没有已下架模型。",
  purgeCatalogUnread: "没有移除任何条目，但目录读取失败——联网后重试。",
  purgeUnavailable: "不可用：此组合没有 config editor。",
  purgeFailed: "清理失败",
  usageSummaryTitle: "Go 用量",
  usageSummaryStatusOk: "状态正常",
  usageSummaryStatusLimited: "已达限额",
  loginAction: "登录 OpenCode",
  loginAgain: "重新登录",
  loginExpired: "验证码已过期",
  loginFailed: "登录失败",
  loginSignedIn: "已登录",
  loginSignedOut: "未登录",
  loginPlane: "登录到",
  loginPlaneGo: "Go（订阅）",
  loginPlaneZen: "Zen（按量付费）",
  loginTitle: "OpenCode 账户",
  loginWaiting: "等待批准…",
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
 * A `t` that asks the seat's dictionary first and THIS bundle's second.
 *
 * The locale service keeps one dictionary per (namespace, locale) and throws on a
 * second registration, so whichever copy of this bundle registered first owns the
 * namespace. A page that outlived a rebuild therefore serves the older dictionary:
 * every key that existed then translates, and every key added since renders
 * verbatim — `goPlanTitle` reached the screen that way, and then `storeInspectTitle`
 * did, on the settings card, because that card still trusted the seat alone.
 *
 * The seat still wins when it HAS the key: a host-side translation, or a locale
 * this bundle does not ship, must keep working. The bundle is the fallback, which
 * is the case that was missing — a seat's miss is indistinguishable from "this
 * dictionary predates the key", and the second is what happens here.
 *
 * Pure: the locale arrives as a getter, so a language switch lands on the next
 * call rather than the next mount.
 *
 * @param base - the seat's translator, whose misses fall through.
 * @param active - the active locale id, read per call; absent means English.
 * @returns a translator that cannot render a key this bundle defines.
 */
export const withBundleCopy =
  <K extends string>(
    base: (key: K) => string,
    active?: () => string | undefined
  ): ((key: K) => string) =>
  (key: K): string => {
    const fromSeat = base(key);
    if (fromSeat !== key) {
      return fromSeat;
    }
    // Widened on purpose: the dictionary is a closed type and the key is whatever
    // the caller asked for, so a miss is `?? key` rather than a compile error.
    const dict: Record<string, string> = active?.() === "zh" ? zh : en;
    return dict[key] ?? key;
  };

/**
 * Every copy key the dictionaries define.
 *
 * Exported so the field register (`settings-fields.ts`) can type its
 * `labelKey` / `hintKey` against it: a field whose copy was never written is
 * then a compile error rather than a raw key in the UI.
 */
export type CopyKey = keyof typeof en;
