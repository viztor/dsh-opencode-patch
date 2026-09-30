/**
 * `dsh-opencode` settings page — DSH Web client bundle.
 * Contributes a settings card under DSH Settings -> Plugins.
 *
 * @module dsh-opencode/settings-page
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

export const NS = "dsh-opencode";

export const inject = ["slots", "locale", "configForms"];

const en = {
  description:
    "OpenCode Zen gateway origin headers, session affinity, and free-tier compatibility.",
  injectCoreTools: "Inject Core Tools",
  injectCoreToolsHint:
    "Auto-injects read and bash tool schemas on free-tier requests to satisfy gateway validation.",
  injectOriginHeaders: "Inject Origin Headers",
  injectOriginHeadersHint:
    "Injects x-opencode-client and x-opencode-project headers.",
  injectUserAgent: "Inject User-Agent",
  injectUserAgentHint:
    "Restores the opencode CLI User-Agent stripped by the DSH LLM adapter.",
  invalidBoolean: "Enter true or false, or leave blank for default.",
  invalidText: "This value was not accepted; leave blank for default.",
  overridden: "Overridden",
  providers: "Providers",
  providersHint: "Comma-separated list of route IDs to intercept.",
  readOnly: "This deployment stores settings read-only.",
  reset: "Reset to default",
  save: "Save",
  saveFailed: "The deployment did not accept these values.",
  saving: "Saving…",
  title: "OpenCode Integration",
  unavailable: "This plugin is not loaded, so it cannot be configured.",
  userAgent: "User-Agent Override",
  userAgentHint:
    "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI string.",
};

const zh = {
  description: "OpenCode Zen 网关来源头恢复、会话保持与免费模型兼容支持。",
  injectCoreTools: "自动补全核心工具",
  injectCoreToolsHint:
    "在免费模型请求中自动注入 read 和 bash 工具声明以满足网关校验。",
  injectOriginHeaders: "注入客户端来源头",
  injectOriginHeadersHint:
    "注入 x-opencode-client 与 x-opencode-project 头部信息。",
  injectUserAgent: "恢复 User-Agent",
  injectUserAgentHint:
    "恢复被 DSH 适配器过滤掉的官方 OpenCode CLI User-Agent。",
  invalidBoolean: "请输入 true 或 false，留空使用默认值。",
  invalidText: "该值未被接受，留空使用默认值。",
  overridden: "已覆盖",
  providers: "生效提供方",
  providersHint: "逗号分隔的提供方路由 ID 列表。",
  readOnly: "当前部署配置为只读。",
  reset: "恢复默认",
  save: "保存",
  saveFailed: "保存失败，请检查填写内容。",
  saving: "保存中…",
  title: "OpenCode 接入设置",
  unavailable: "插件未加载，暂无法配置。",
  userAgent: "自定义 User-Agent",
  userAgentHint: "自定义 User-Agent 字符串。留空则使用默认 OpenCode CLI 标识。",
};

const FIELD = {
  injectCoreTools: "injectCoreTools",
  injectOriginHeaders: "injectOriginHeaders",
  injectUserAgent: "injectUserAgent",
  providers: "providers",
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
  view: "summary" | "form";
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
    register: (ns: string, dicts: Record<string, unknown>) => void;
  };
  slots?: {
    inject: (name: string, fn: () => void) => void;
    register: (entry: Record<string, unknown>, component: unknown) => void;
  };
}

export const apply = (ctx: ClientContext): void => {
  const t = ctx.locale?.bind?.(NS) ?? ((k: string) => k);
  ctx.effect?.(() => {
    ctx.locale?.register?.(NS, { en, zh });
  }, "dsh-opencode: dictionaries");

  const rawScope = ctx.configForms?.get?.(NS);
  if (!rawScope) {
    return;
  }
  const scope = rawScope as SettingsFormScope<Record<string, unknown>>;

  const model = new SettingsFormModel(scope, SPECS);
  const store = model.bind(() => ({
    fields: Object.fromEntries(
      SPECS.map((spec) => [spec.field, model.field(spec.field)])
    ),
    shell: model.shell(),
  }));

  ctx.configForms?.whileServed?.([NS], () => {
    ctx.slots?.inject?.("plugins.item", () => {
      ctx.slots?.register?.(
        {
          id: "opencode",
          inject: () => ({
            hooks: { opencodeCard: store },
            ...model.actions(),
          }),
          label: () => t("title"),
          locale: NS,
          name: "plugins.item",
          order: 50,
        },
        OpencodeCard
      );
    });
  });
};
