/**
 * `dsh-opencode-patch` settings page — DSH Web client bundle.
 * Contributes a settings card under DSH Settings -> Plugins and a quota pill
 * in the composer dock (`conversation.composer.dock`) for OpenCode Go models.
 *
 * Locale copy lives in `settings-copy.ts` and the field register in
 * `settings-fields.ts`; this module owns wiring: card rendering, scope
 * validation, and `apply`.
 *
 * @module dsh-opencode-patch/settings-page
 */

import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  Tag,
  type SettingsFormScope,
  type SettingsFormShell,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import {
  DEFAULT_SHOW_USAGE_PRICE,
  DEFAULT_USAGE_PROVIDER_MARKERS,
  readBoolean,
  readStringList,
} from "./config-values.ts";
import { isRecord } from "./guards.ts";
import { en, zh, type Translate } from "./settings-copy.ts";
import { FIELD, SPECS } from "./settings-fields.ts";
import { UsagePill } from "./usage-pill.tsx";

// Re-exported so the field register stays reachable from the bundle entry.
export { SPECS };

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

interface BooleanFieldProps {
  disabled: boolean;
  hint?: string;
  id: string;
  label: string;
  onEdit: (text: string) => void;
  onReset: () => void;
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
  text: string;
}

/**
 * A boolean toggle field that uses the Switch primitive.
 *
 * Mirrors the label/override-badge/reset/hint chrome of SettingsValueField
 * but replaces the text input with a Switch so boolean config knobs render
 * as proper toggles instead of "true"/"false" text boxes.
 */
const SettingsBooleanField: React.FC<BooleanFieldProps> = (
  props: BooleanFieldProps
) => {
  const checked = props.text === "true";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: "8px",
          justifyContent: "space-between",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: "6px" }}>
          <label
            htmlFor={props.id}
            style={{ fontSize: "13px", fontWeight: 500 }}
          >
            {props.label}
          </label>
          {props.overridden ? (
            <>
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <button
                disabled={props.disabled}
                onClick={props.onReset}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-fg-subtle, #8b949e)",
                  cursor: props.disabled ? "default" : "pointer",
                  fontSize: "11px",
                  padding: "0",
                }}
                type="button"
              >
                {props.resetLabel}
              </button>
            </>
          ) : null}
        </div>
        <Switch
          checked={checked}
          disabled={props.disabled}
          label={props.label}
          onChange={(next: boolean) => {
            props.onEdit(String(next));
          }}
        />
      </div>
      {props.hint === undefined ? null : (
        <p
          style={{
            color: "var(--color-fg-subtle, #8b949e)",
            fontSize: "12px",
            margin: 0,
          }}
        >
          {props.hint}
        </p>
      )}
    </div>
  );
};

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

  const boolField = (name: string) => {
    const f = state.fields[name] ?? {
      invalid: false,
      overridden: false,
      text: "",
    };
    return {
      disabled,
      id: `plugin-config-opencode-${name}`,
      onEdit: (text: string) => {
        props.edit(name, text);
      },
      onReset: () => {
        props.resetField(name);
      },
      overridden: f.overridden,
      overriddenLabel: t("overridden"),
      resetLabel: t("reset"),
      text: f.text,
    };
  };

  return (
    <SettingsForm
      labels={formLabels(t)}
      onDiscard={props.discard}
      onSave={props.save}
      state={state.shell}
    >
      <SettingsBooleanField
        {...boolField(FIELD.injectUserAgent)}
        hint={t("injectUserAgentHint")}
        label={t("injectUserAgent")}
      />
      <SettingsValueField
        {...field(FIELD.userAgent)}
        hint={t("userAgentHint")}
        label={t("userAgent")}
        placeholder="opencode/1.18.33 ..."
      />
      <SettingsBooleanField
        {...boolField(FIELD.injectOriginHeaders)}
        hint={t("injectOriginHeadersHint")}
        label={t("injectOriginHeaders")}
      />
      <SettingsValueField
        {...field(FIELD.originClient)}
        hint={t("originClientHint")}
        label={t("originClient")}
        placeholder="cli"
      />
      <SettingsBooleanField
        {...boolField(FIELD.injectProject)}
        hint={t("injectProjectHint")}
        label={t("injectProject")}
      />
      <SettingsBooleanField
        {...boolField(FIELD.injectCoreTools)}
        hint={t("injectCoreToolsHint")}
        label={t("injectCoreTools")}
      />
      <SettingsValueField
        {...field(FIELD.freeModelMarker)}
        hint={t("freeModelMarkerHint")}
        label={t("freeModelMarker")}
        placeholder="free"
      />
      <SettingsValueField
        {...field(FIELD.providers)}
        hint={t("providersHint")}
        label={t("providers")}
        placeholder="opencode, opencode-go"
      />
      <SettingsValueField
        {...field(FIELD.gatewayUrls)}
        hint={t("gatewayUrlsHint")}
        label={t("gatewayUrls")}
        placeholder="opencode.ai/zen"
      />
      <SettingsValueField
        {...field(FIELD.sessionIdEnv)}
        hint={t("sessionIdEnvHint")}
        label={t("sessionIdEnv")}
        placeholder="OPENCODE_SESSION_ID"
      />
      <SettingsBooleanField
        {...boolField(FIELD.usageEnabled)}
        hint={t("usageEnabledHint")}
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
        {...field(FIELD.usageProviderMarkers)}
        hint={t("usageProviderMarkersHint")}
        label={t("usageProviderMarkers")}
        placeholder="opencode-go"
      />
    </SettingsForm>
  );
};

export interface ClientContext {
  configForms?: {
    get: (ns: string) => unknown;
    whileServed: (
      ns: string[],
      fn: () => (() => void) | undefined
    ) => (() => void) | undefined;
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
    inject: (
      name: string,
      fn: () => (() => void) | undefined
    ) => (() => void) | undefined;
    register: (
      entry: Record<string, unknown>,
      component: unknown
    ) => (() => void) | undefined;
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

  // Resolve the settings scope BEFORE wiring the dock injector so the quota
  // meter can read the configured trigger markers from it at inject time.
  // The injector still registers when there is no scope: the meter has work
  // to do as long as the Host serves the usage service.
  const rawScope: unknown =
    ctx.configForms?.get?.(NS) ?? ctx.configForms?.get?.(LEGACY_NS);
  const scope = isSettingsFormScope(rawScope) ? rawScope : undefined;

  /**
   * The configured quota-meter markers from the scope's current value,
   * falling back to the plugin defaults while the scope is loading or the
   * fields carry no user value.
   */
  const usageMarkers = (): {
    providerMarkers: string[];
    showUsagePrice: boolean;
  } => {
    const value: unknown = scope?.getSnapshot().value;
    const record = isRecord(value) ? value : {};
    const providerMarkers = readStringList(record.usageProviderMarkers);
    return {
      providerMarkers:
        providerMarkers.length > 0
          ? providerMarkers
          : DEFAULT_USAGE_PROVIDER_MARKERS,
      showUsagePrice: readBoolean(
        record.showUsagePrice,
        DEFAULT_SHOW_USAGE_PRICE
      ),
    };
  };

  const createUsageInjector = () => (sessionId: unknown) => {
    const directory: unknown =
      ctx.modelDirectories?.directoryFor?.(sessionId)?.store;
    if (directory === undefined || directory === null) {
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
    const markers = usageMarkers();
    return {
      directory,
      ...markers,
      readUsage: async () => {
        const res: unknown = await ctx.remote?.opencodeGoUsage?.read?.();
        // The envelope is `{ok: true, value} | {ok: false, error}`. Narrowing
        // `ok` to a boolean lets the branch read as plain truthiness — the
        // lint config rejects coercing an `unknown` inside the condition.
        if (isRecord(res) && typeof res.ok === "boolean") {
          if (res.ok) {
            return "value" in res ? res.value : undefined;
          }
          throw "error" in res ? res.error : undefined;
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
  //
  // The inject callback returns the registration's disposer: the slot
  // re-runs this callback whenever the dock is collapsed and re-declared
  // (live reload does exactly that), and re-registering the same entry id
  // without disposing the previous one throws.
  ctx.slots?.inject?.("conversation.composer.dock", () =>
    ctx.slots?.register?.(
      {
        id: "dsh-opencode-patch-usage",
        inject: createUsageInjector(),
        name: "conversation.composer.dock",
        order: 50,
      },
      UsagePill
    )
  );

  // Without a served scope the card cannot render or save, so the form and
  // its registrations stop here — the dock injector above stays registered.
  if (scope === undefined) {
    return;
  }

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

  // `plugins.bundle.config` (NOT `plugins.item`): third-party bundles
  // render their own configuration on the bundle's page, keyed by npm
  // package name. The hook key becomes the `useOpencodeCard` prop; the
  // actions spread in as `edit` / `resetField` / `save` / `discard`.
  //
  // Registered directly in ctx.effect so the bundle configuration card is
  // always available when viewing the installed package detail page, rather
  // than depending on whether the host has already re-described its namespaces.
  ctx.effect?.(() => {
    const stop = ctx.slots?.inject?.("plugins.bundle.config", () => {
      const cards: (() => void)[] = [];
      const keepCard = (dispose: (() => void) | undefined): void => {
        if (typeof dispose === "function") {
          cards.push(dispose);
        }
      };
      // One registration per package alias: the current npm name, the legacy
      // scoped name, and the legacy bare namespace — each keyed and locale
      // bound exactly as its page lookup expects.
      const aliases: { key: string; locale: string }[] = [
        { key: PKG, locale: NS },
        { key: LEGACY_PKG, locale: LEGACY_NS },
        { key: LEGACY_NS, locale: LEGACY_NS },
      ];
      for (const alias of aliases) {
        keepCard(
          ctx.slots?.register?.(
            {
              inject: () => ({
                hooks: { opencodeCard: store },
                ...model.actions(),
              }),
              key: alias.key,
              locale: alias.locale,
              name: "plugins.bundle.config",
            },
            OpencodeCard
          )
        );
      }
      return () => {
        for (const dispose of cards) {
          dispose();
        }
      };
    });
    return () => {
      if (typeof stop === "function") {
        stop();
      }
    };
  }, "dsh-opencode-patch: settings");
};
