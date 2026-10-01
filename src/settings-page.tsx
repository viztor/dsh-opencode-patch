/**
 * `dsh-opencode-patch` settings page — DSH Web client bundle.
 * Contributes a settings card under DSH Settings -> Plugins and a quota pill
 * in the conversation input tray for OpenCode Go models.
 *
 * @module dsh-opencode-patch/settings-page
 */

import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFormScope,
  type SettingsFormShell,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import { UsagePill } from "./usage-pill.tsx";

export const NS = "dsh-opencode-patch";
export const LEGACY_NS = "dsh-opencode";

/**
 * The bundle's npm package name, spelled rather than imported.
 *
 * `plugins.bundle.config` entries are keyed by npm package name (not the
 * cordis row id), so this must equal `package.json`'s `name`. The client
 * half must not depend on the host half, hence the duplication.
 */
export const PKG = "dsh-opencode-patch";
export const LEGACY_PKG = "@viztor/dsh-opencode";

export const inject = [
  "slots",
  "locale",
  "configForms",
  "modelDirectories",
  "remote",
];

const en = {
  debug: "Debug Logging (default off)",
  debugFile: "Debug File",
  debugFileHint:
    "Absolute server-side path the plugin appends JSONL stream-debug entries to. Leave blank for none.",
  debugHint:
    "Logs every streamed call receiving the header via ctx.logger. Empty inherits the default.",
  description:
    "OpenCode Zen gateway origin headers, session affinity, free-tier compatibility, and live Go quota display.",
  injectCoreTools: "Inject Core Tools (default on)",
  injectCoreToolsHint:
    "Auto-injects read and bash tool schemas on free-tier requests to satisfy gateway validation. Empty inherits the default.",
  injectOriginHeaders: "Inject Origin Headers (default on)",
  injectOriginHeadersHint:
    "Injects x-opencode-client and x-opencode-project headers. Empty inherits the default.",
  injectUserAgent: "Inject User-Agent (default on)",
  injectUserAgentHint:
    "Restores the opencode CLI User-Agent stripped by the DSH LLM adapter. Empty inherits the default.",
  invalidBoolean: "Enter true or false, or leave blank for default.",
  invalidText: "This value was not accepted; leave blank for default.",
  overridden: "Overridden",
  providers: "Providers",
  providersHint:
    "Comma-separated list of route IDs to intercept. Default: opencode, opencode-go.",
  readOnly: "This deployment stores settings read-only.",
  reset: "Reset to default",
  save: "Save",
  saveFailed: "The deployment did not accept these values.",
  saving: "Saving…",
  title: "OpenCode Integration",
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
  usage_monthly: "Monthly",
  usage_rolling: "5 hours",
  usage_weekly: "Weekly",
  userAgent: "User-Agent Override",
  userAgentHint:
    "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI string.",
};

const zh = {
  debug: "调试日志（默认关闭）",
  debugFile: "调试文件",
  debugFileHint: "插件追加 JSONL 流调试记录的服务端绝对路径。留空表示不记录。",
  debugHint: "通过 ctx.logger 记录每次注入会话头的流式调用。留空沿用默认值。",
  description:
    "OpenCode Zen 网关来源头恢复、会话保持、免费模型兼容与 Go 实时额度显示。",
  injectCoreTools: "自动补全核心工具（默认开启）",
  injectCoreToolsHint:
    "在免费模型请求中自动注入 read 和 bash 工具声明以满足网关校验。留空沿用默认值。",
  injectOriginHeaders: "注入客户端来源头（默认开启）",
  injectOriginHeadersHint:
    "注入 x-opencode-client 与 x-opencode-project 头部信息。留空沿用默认值。",
  injectUserAgent: "恢复 User-Agent（默认开启）",
  injectUserAgentHint:
    "恢复被 DSH 适配器过滤掉的官方 OpenCode CLI User-Agent。留空沿用默认值。",
  invalidBoolean: "请输入 true 或 false，留空使用默认值。",
  invalidText: "该值未被接受，留空使用默认值。",
  overridden: "已覆盖",
  providers: "生效提供方",
  providersHint: "逗号分隔的提供方路由 ID 列表。默认：opencode, opencode-go。",
  readOnly: "当前部署配置为只读。",
  reset: "恢复默认",
  save: "保存",
  saveFailed: "保存失败，请检查填写内容。",
  saving: "保存中…",
  title: "OpenCode 接入设置",
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
  usage_monthly: "每月",
  usage_rolling: "5 小时",
  usage_weekly: "每周",
  userAgent: "自定义 User-Agent",
  userAgentHint: "自定义 User-Agent 字符串。留空则使用默认 OpenCode CLI 标识。",
};

const FIELD = {
  debug: "debug",
  debugFile: "debugFile",
  injectCoreTools: "injectCoreTools",
  injectOriginHeaders: "injectOriginHeaders",
  injectUserAgent: "injectUserAgent",
  providers: "providers",
  usageBaseURL: "usageBaseURL",
  usageEnabled: "usageEnabled",
  usageKeyEnv: "usageKeyEnv",
  userAgent: "userAgent",
};

const BOOLEAN_DRAFTS: Record<
  string,
  { kind: "set"; value: boolean } | { kind: "clear" }
> = {
  "": { kind: "clear" },
  false: { kind: "set", value: false },
  true: { kind: "set", value: true },
};

const settingsBooleanField = (field: string): SettingsFieldSpec => ({
  field,
  format: (value: unknown) => (typeof value === "boolean" ? String(value) : ""),
  parse: (text: string) => BOOLEAN_DRAFTS[text.trim().toLowerCase()],
});

const SPECS: SettingsFieldSpec[] = [
  settingsBooleanField(FIELD.injectUserAgent),
  settingsTextField(FIELD.userAgent),
  settingsBooleanField(FIELD.injectOriginHeaders),
  settingsBooleanField(FIELD.injectCoreTools),
  settingsTextField(FIELD.providers),
  settingsBooleanField(FIELD.usageEnabled),
  settingsTextField(FIELD.usageBaseURL),
  settingsTextField(FIELD.usageKeyEnv),
  settingsBooleanField(FIELD.debug),
  settingsTextField(FIELD.debugFile),
];

type Translate = (key: keyof typeof en) => string;

interface CardField {
  invalid: boolean;
  overridden: boolean;
  text: string;
}

interface CardState {
  fields: Record<string, CardField>;
  shell: SettingsFormShell;
}

interface CardProps {
  discard: () => void;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  t: Translate;
  useOpencodeCard: (selector: (snapshot: CardState) => CardState) => CardState;
  view: "summary" | "page";
}

const formLabels = (t: Translate) => ({
  readOnly: t("readOnly"),
  save: t("save"),
  saveFailed: t("saveFailed"),
  saving: t("saving"),
  unavailable: t("unavailable"),
});

const OpencodeCard: React.FC<CardProps> = (props: CardProps) => {
  const { t } = props;
  if (props.view === "summary") {
    return <>{t("description")}</>;
  }

  const state = props.useOpencodeCard((snapshot) => snapshot);
  const disabled = !state.shell.writable;

  const field = (name: string) => ({
    disabled,
    id: `plugin-config-opencode-${name}`,
    invalidLabel: t("invalidText"),
    onEdit: (text: string) => {
      props.edit(name, text);
    },
    onReset: () => {
      props.resetField(name);
    },
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    ...(state.fields[name] ?? { invalid: false, overridden: false, text: "" }),
  });

  return (
    <SettingsForm
      labels={formLabels(t)}
      onDiscard={props.discard}
      onSave={props.save}
      state={state.shell}
    >
      <SettingsValueField
        {...field(FIELD.injectUserAgent)}
        hint={t("injectUserAgentHint")}
        invalidLabel={t("invalidBoolean")}
        label={t("injectUserAgent")}
      />
      <SettingsValueField
        {...field(FIELD.userAgent)}
        hint={t("userAgentHint")}
        label={t("userAgent")}
        placeholder="opencode/1.18.33 ..."
      />
      <SettingsValueField
        {...field(FIELD.injectOriginHeaders)}
        hint={t("injectOriginHeadersHint")}
        invalidLabel={t("invalidBoolean")}
        label={t("injectOriginHeaders")}
      />
      <SettingsValueField
        {...field(FIELD.injectCoreTools)}
        hint={t("injectCoreToolsHint")}
        invalidLabel={t("invalidBoolean")}
        label={t("injectCoreTools")}
      />
      <SettingsValueField
        {...field(FIELD.providers)}
        hint={t("providersHint")}
        label={t("providers")}
        placeholder="opencode, opencode-go"
      />
      <SettingsValueField
        {...field(FIELD.usageEnabled)}
        hint={t("usageEnabledHint")}
        invalidLabel={t("invalidBoolean")}
        label={t("usageEnabled")}
      />
      <SettingsValueField
        {...field(FIELD.usageBaseURL)}
        hint={t("usageBaseURLHint")}
        label={t("usageBaseURL")}
        placeholder="https://opencode.ai/zen/go/v1"
      />
      <SettingsValueField
        {...field(FIELD.usageKeyEnv)}
        hint={t("usageKeyEnvHint")}
        label={t("usageKeyEnv")}
        placeholder="OPENCODE_GO_API_KEY"
      />
      <SettingsValueField
        {...field(FIELD.debug)}
        hint={t("debugHint")}
        invalidLabel={t("invalidBoolean")}
        label={t("debug")}
      />
      <SettingsValueField
        {...field(FIELD.debugFile)}
        hint={t("debugFileHint")}
        label={t("debugFile")}
        placeholder="/tmp/dsh-opencode-debug.jsonl"
      />
    </SettingsForm>
  );
};

export interface ClientContext {
  configForms?: {
    get: (ns: string) => unknown;
    whileServed: (ns: string[], fn: () => void) => void;
  };
  effect?: (fn: () => unknown, name?: string) => void;
  locale?: {
    bind: (ns: string) => (key: string) => string;
    register: (
      ns: string,
      dicts: Record<string, unknown>
    ) => (() => void) | undefined;
  };
  modelDirectories?: {
    directoryFor: (sessionId: unknown) => { store: unknown };
  };
  remote?: {
    opencodeGoUsage?: { read: () => Promise<unknown> };
  };
  slots?: {
    inject: (name: string, fn: () => void) => void;
    register: (entry: Record<string, unknown>, component: unknown) => void;
  };
}

const isSettingsFormScope = (
  value: unknown
): value is SettingsFormScope<Record<string, unknown>> => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (!("getSnapshot" in value && "subscribe" in value && "mutate" in value)) {
    return false;
  }
  const snapshot: unknown = value.getSnapshot;
  const subscribe: unknown = value.subscribe;
  const mutate: unknown = value.mutate;
  return (
    typeof snapshot === "function" &&
    typeof subscribe === "function" &&
    typeof mutate === "function"
  );
};

const noopDisposer = (): void => {
  /* no-op */
};

export const apply = (ctx: ClientContext): void => {
  ctx.effect?.(() => {
    try {
      ctx.locale?.register?.(NS, { en, zh });
    } catch {
      // ignore duplicate
    }
    try {
      ctx.locale?.register?.(LEGACY_NS, { en, zh });
    } catch {
      // ignore duplicate
    }
    return noopDisposer;
  }, "dsh-opencode-patch: dictionaries");

  const createUsageInjector = () => (sessionId: unknown) => {
    const directory = ctx.modelDirectories?.directoryFor?.(sessionId)?.store;
    if (!directory) {
      return null;
    }
    // No Host service means there is nothing to measure. That covers both
    // "Usage Quota Tracking is switched off" (the Host only registers
    // `opencodeGoUsage` when `usageEnabled` is on) and a mimetype/version
    // mismatch — either way the meter is absent rather than showing an
    // unavailable state the user cannot act on. This is read at inject time,
    // so it follows the Host service rather than the page's first render.
    if (typeof ctx.remote?.opencodeGoUsage?.read !== "function") {
      return null;
    }
    return {
      directory,
      readUsage: async () => {
        const res = (await ctx.remote?.opencodeGoUsage?.read?.()) as
          | { ok: true; value: unknown }
          | { ok: false; error: unknown }
          | undefined;
        if (res && typeof res === "object" && "ok" in res) {
          if (!res.ok) throw res.error;
          return res.value;
        }
        return res;
      },
      t: ctx.locale?.bind?.(NS) ?? ((key: string) => key),
    };
  };

  // The quota meter mounts in exactly ONE slot.
  //
  // It is the composer dock, beneath the input card and beside the Context
  // meter, because that is where the harness already puts per-turn diagnostics.
  // It must not also be registered in `conversation.input.right`: both slots
  // render, so registering twice drew the meter twice side by side. One
  // registration, one meter.
  ctx.slots?.inject?.("conversation.composer.dock", () => {
    ctx.slots?.register?.(
      {
        id: "dsh-opencode-patch-usage",
        inject: createUsageInjector(),
        name: "conversation.composer.dock",
        order: 50,
      },
      UsagePill
    );
  });

  const rawScope: unknown =
    ctx.configForms?.get?.(NS) ?? ctx.configForms?.get?.(LEGACY_NS);
  if (!isSettingsFormScope(rawScope)) {
    return;
  }
  const scope = rawScope;

  const model = new SettingsFormModel(scope, SPECS);
  const store = model.bind(() => ({
    fields: Object.fromEntries(
      SPECS.map((spec) => [spec.field, model.field(spec.field)])
    ),
    shell: model.shell(),
  }));

  ctx.effect?.(
    () => () => {
      model.dispose();
    },
    "dsh-opencode-patch: form subscription"
  );

  ctx.configForms?.whileServed?.([NS, LEGACY_NS], () => {
    // `plugins.bundle.config` (NOT `plugins.item`): third-party bundles
    // render their own configuration on the bundle's page, keyed by npm
    // package name. The hook key becomes the `useOpencodeCard` prop; the
    // actions spread in as `edit` / `resetField` / `save` / `discard`.
    ctx.slots?.inject?.("plugins.bundle.config", () => {
      // Register for primary package name
      ctx.slots?.register?.(
        {
          inject: () => ({
            hooks: { opencodeCard: store },
            ...model.actions(),
          }),
          key: PKG,
          locale: NS,
          name: "plugins.bundle.config",
        },
        OpencodeCard
      );
      // Register for legacy scoped package name
      ctx.slots?.register?.(
        {
          inject: () => ({
            hooks: { opencodeCard: store },
            ...model.actions(),
          }),
          key: LEGACY_PKG,
          locale: LEGACY_NS,
          name: "plugins.bundle.config",
        },
        OpencodeCard
      );
      // Register for legacy bare component name
      ctx.slots?.register?.(
        {
          inject: () => ({
            hooks: { opencodeCard: store },
            ...model.actions(),
          }),
          key: LEGACY_NS,
          locale: LEGACY_NS,
          name: "plugins.bundle.config",
        },
        OpencodeCard
      );
    });
  });
};
