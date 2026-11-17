/**
 * The settings, pinned as the plugin derives them: the schema the loader
 * validates the row with, the resolver's every key, the card's field specs and
 * the copy keys.
 *
 * Written before P8 moved all of it onto one table (`src/settings-table.ts`)
 * and run green on the hand-written tree, so the refactor is held to the same
 * literals. The expectations are copied from that tree, not computed from the
 * table, because a pin that reads its subject cannot see it change. The edits
 * the refactor made to this file are named: in the copy keys, P8 deleted
 * fifteen keys nothing rendered and added the card's re-apply line;
 * `CONFIG_DEFAULTS` no longer carries `credentialOrg: undefined`; and the
 * resolved type's three keys without a default are optional and none is
 * readonly.
 *
 * @module test/settings-snapshot.test
 */

import { describe, expect, it } from "vitest";

import {
  CARD_FIELDS,
  Config,
  CONFIG_DEFAULTS,
  CONFIG_ONLY_FIELDS,
  en,
  ENDPOINT_FAMILIES,
  KEY_SOURCE_POLICIES,
  type PluginConfig,
  resolveConfig,
  type ResolvedPluginConfig,
  SPECS,
  zh,
} from "./support/src.ts";

/** One schema node, read the way `settings.describe` and the loader read it. */
interface SchemaPin {
  default: unknown;
  description: unknown;
  inner: string | undefined;
  meta: string[];
  type: string;
  volatile: boolean;
}

const MARKS = ["default", "description", "volatile"];

/** Every key of `Config`, as the hand-written schema declared it. */
const SCHEMA: Record<string, SchemaPin> = {
  endpoint: {
    default: "auto",
    description:
      "Which endpoint family the gateway's requests go to. modern: the per-protocol inference family, https://opencode.ai/inference/{openai,anthropic,google}/... on Zen and https://opencode.ai/inference/go/{openai,anthropic,google}/... on Go. auto: an alias of modern, and the default. legacy: the older single base per plane, https://opencode.ai/zen/v1 and https://opencode.ai/zen/go/v1. The two families are separately entitled and both still answer, so this is a choice rather than a migration; an unrecognised value falls back to auto.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
  keySource: {
    default: "auto",
    description:
      "Which credential source wins when several resolve. auto: a literal key declared in another entry, then a key captured from a live request, then the declared reference, then a captured key for the other plane. request: a captured key first, then a literal one, then the declared reference. configured: a literal key, then the declared reference, then captured ones. An unrecognised value falls back to auto.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
  readOpencodeStore: {
    default: false,
    description:
      "Read the credential the OpenCode installation already holds, from its own database, as the LAST resort: after every credential this deployment declares. Off by default — reading another tool's store is something a user turns on, not something that happens to them.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  injectUserAgent: {
    default: true,
    description:
      "Restore the opencode CLI User-Agent stripped by the DSH LLM adapter.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  injectOriginHeaders: {
    default: true,
    description: "Inject x-opencode-client header.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  injectProject: {
    default: true,
    description:
      "Attach the active workspace folder name (or 'global' if outside a project) in x-opencode-project.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  enrichModels: {
    default: true,
    description:
      "Enrich the gateway /models listing and Settings model discovery from the OpenCode catalog; a plane's model info follows the user's row and the catalog either way.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  injectCoreTools: {
    default: true,
    description:
      "Auto-inject read and bash tool schemas on free-tier requests.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  usageEnabled: {
    default: true,
    description: "Enable host-side OpenCode Go usage querying.",
    inner: undefined,
    meta: MARKS,
    type: "boolean",
    volatile: true,
  },
  credentialOrg: {
    default: undefined,
    description:
      "The org id (wrk_...) to send with an account credential. A login through this plugin stores the org with the token, so this is only for a token that came from elsewhere.",
    inner: undefined,
    meta: ["description", "volatile"],
    type: "string",
    volatile: true,
  },
  debug: {
    default: false,
    description: "Log injected streamed calls.",
    inner: undefined,
    meta: ["default", "description"],
    type: "boolean",
    volatile: false,
  },
  debugFile: {
    default: undefined,
    description: "Server-side path for JSONL stream-debug entries.",
    inner: undefined,
    meta: ["description"],
    type: "string",
    volatile: false,
  },
  userAgent: {
    default: undefined,
    description:
      "Custom User-Agent string. Leave blank to use the canonical OpenCode CLI one.",
    inner: undefined,
    meta: ["description", "volatile"],
    type: "string",
    volatile: true,
  },
  originClient: {
    default: "cli",
    description: "Value restored into the x-opencode-client header.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
  sessionIdEnv: {
    default: "OPENCODE_SESSION_ID",
    description:
      "Environment variable consulted for the fallback session id outside a turn.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
  freeModelMarker: {
    default: "free",
    description:
      "Model-id marker triggering the core-tool fallback; * applies to every model.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
  providers: {
    default: ["opencode", "opencode-go"],
    description:
      "Route ids whose turns this plugin decorates; opencode and opencode-go are always included.",
    inner: "string",
    meta: MARKS,
    type: "array",
    volatile: true,
  },
  gatewayUrls: {
    default: ["opencode.ai/zen", "opencode.ai/inference"],
    description:
      "URL substrings marking OpenCode gateway traffic (matched before providers).",
    inner: "string",
    meta: MARKS,
    type: "array",
    volatile: true,
  },
  usageBaseURL: {
    default: "https://opencode.ai/zen/go/v1",
    description: "OpenCode Go gateway base URL.",
    inner: undefined,
    meta: MARKS,
    type: "string",
    volatile: true,
  },
};

/** What an empty row resolves to, every key present. */
const RESOLVED_EMPTY: ResolvedPluginConfig = {
  credentialOrg: undefined,
  debug: false,
  debugFile: undefined,
  endpoint: "auto",
  enrichModels: true,
  freeModelMarker: "free",
  gatewayUrls: ["opencode.ai/zen", "opencode.ai/inference"],
  injectCoreTools: true,
  injectOriginHeaders: true,
  injectProject: true,
  injectUserAgent: true,
  keySource: "auto",
  originClient: "cli",
  providers: new Set(["opencode", "opencode-go"]),
  readOpencodeStore: false,
  sessionIdEnv: "OPENCODE_SESSION_ID",
  usageBaseURL: "https://opencode.ai/zen/go/v1",
  usageEnabled: true,
  userAgent: undefined,
};

/** The keys of each kind, so every key's degradation is run, not a sample. */
const BOOLEAN_KEYS = [
  "readOpencodeStore",
  "injectUserAgent",
  "injectOriginHeaders",
  "injectProject",
  "enrichModels",
  "injectCoreTools",
  "usageEnabled",
  "debug",
] as const;
const STRING_KEYS = [
  "credentialOrg",
  "debugFile",
  "userAgent",
  "originClient",
  "sessionIdEnv",
  "freeModelMarker",
  "usageBaseURL",
] as const;
const CHOICE_KEYS = {
  endpoint: ENDPOINT_FAMILIES,
  keySource: KEY_SOURCE_POLICIES,
} as const;

/** Every copy key that stays, in both languages. */
const LIVE_KEYS = [
  "catalogLastError",
  "description",
  "endpoint",
  "endpointAuto",
  "endpointHint",
  "endpointLegacy",
  "endpointModern",
  "enrichModels",
  "enrichModelsHint",
  "freeModel",
  "goPlanTitle",
  "goPlusTier",
  "goTier",
  "groupAccess",
  "groupModels",
  "groupQuota",
  "groupRequests",
  "injectCoreTools",
  "injectCoreToolsHint",
  "injectOriginHeaders",
  "injectOriginHeadersHint",
  "injectProject",
  "injectProjectHint",
  "injectUserAgent",
  "injectUserAgentHint",
  "invalidText",
  "keySource",
  "keySourceAuto",
  "keySourceConfigured",
  "keySourceHint",
  "keySourceRequest",
  "monthlyAllowance",
  "overridden",
  "purgeAction",
  "purgeBusy",
  "purgeCatalogUnread",
  "purgeFailed",
  "purgeHint",
  "purgeNothing",
  "purgeRemoved",
  "purgeTitle",
  "purgeUnavailable",
  "readOnly",
  "readOpencodeStore",
  "readOpencodeStoreHint",
  "reset",
  "save",
  "saveFailed",
  "saving",
  "sessionSpend",
  "sessionSpendEmpty",
  "storeInspect",
  "storeInspectAccount",
  "storeInspectBusy",
  "storeInspectExpired",
  "storeInspectExpires",
  "storeInspectFailed",
  "storeInspectHint",
  "storeInspectKind",
  "storeInspectKindKey",
  "storeInspectKindOauth",
  "storeInspectKindUnknown",
  "storeInspectMissing",
  "storeInspectNoAccount",
  "storeInspectOrg",
  "storeInspectRefreshable",
  "storeInspectTitle",
  "storeInspectUnavailable",
  "storeInspectValid",
  "unavailable",
  "unservedAction",
  "unservedBusy",
  "unservedHint",
  "unservedNothing",
  "unservedPiUnread",
  "unservedPiUnreadReview",
  "unservedRemoved",
  "unservedTitle",
  "usageAuthRejected",
  "usageConsole",
  "usageEnabled",
  "usageEnabledHint",
  "usageLastUpdated",
  "usageLimited",
  "usageOverflowBilling",
  "usageRefreshFailed",
  "usageRefreshing",
  "usageResetPassed",
  "usageResetUnderMinute",
  "usageResetsAtPrefix",
  "usageResetsAtSuffix",
  "usageResetsIn",
  "usageRetry",
  "usageSummaryAllowance",
  "usageSummaryNote",
  "usageSummaryRemaining",
  "usageSummaryStatusLimited",
  "usageSummaryStatusOk",
  "usageSummaryTitle",
  "usageSummaryUnavailable",
  "usageSummaryUsed",
  "usageTitle",
  "usageTopUp",
  "usageUnavailable",
  "usageUpgradePlan",
  "usageZenFallbackNotice",
  "usage_monthly",
  "usage_rolling",
  "usage_weekly",
  "zenCredit",
  "zenPaygBadge",
  "zenPaygTitle",
  "zenPaygTooltip",
];

/** The keys P8 deleted: nothing in `src` rendered any of them. */
const DELETED_IN_P8 = [
  "storeInspectFound",
  "loginAction",
  "loginAgain",
  "loginExpired",
  "loginFailed",
  "loginSignedIn",
  "loginSignedOut",
  "loginPlane",
  "loginPlaneGo",
  "loginPlaneZen",
  "loginTitle",
  "loginWaiting",
  "zenFallbackNotice",
  "zenOverflowActive",
  "title",
];

/** A volatile node's value, or the value itself. */
const unwrap = (value: unknown): unknown =>
  value !== null &&
  typeof value === "object" &&
  "get" in value &&
  typeof value.get === "function"
    ? Reflect.apply(value.get, value, [])
    : value;

const hasGet = (value: unknown): boolean => unwrap(value) !== value;

describe("the settings, as the plugin derives them", () => {
  it("the schema: every key's type, default, volatile flag and description", () => {
    expect(Config.type).toBe("object");
    const dict = Config.dict ?? {};
    const actual = Object.fromEntries(
      Object.entries(dict).map(([key, schema]) => [
        key,
        {
          default: schema.meta.default,
          description: schema.meta.description,
          inner: schema.inner?.type,
          // The flag list itself, so a new one (loose, required, hidden)
          // fails here rather than changing the schema quietly.
          meta: Object.keys(schema.meta).toSorted(),
          type: schema.type,
          volatile: schema.meta.volatile === true,
        },
      ])
    );
    expect(Object.keys(actual)).toHaveLength(19);
    expect(actual).toStrictEqual(SCHEMA);
  });

  it("the schema, run: an empty row, a typo and a wrong type", () => {
    /** A hand-edited row: the schema's input type would refuse the cases. */
    const load = (input: Record<string, unknown>): Record<string, unknown> =>
      Config(input as never);
    const row = load({});
    // debugFile has neither a default nor `.volatile()`, so it is absent.
    expect(Object.hasOwn(row, "debugFile")).toBe(false);
    expect(
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, unwrap(value)])
      )
    ).toStrictEqual({
      credentialOrg: undefined,
      debug: false,
      endpoint: "auto",
      enrichModels: true,
      freeModelMarker: "free",
      gatewayUrls: ["opencode.ai/zen", "opencode.ai/inference"],
      injectCoreTools: true,
      injectOriginHeaders: true,
      injectProject: true,
      injectUserAgent: true,
      keySource: "auto",
      originClient: "cli",
      providers: ["opencode", "opencode-go"],
      readOpencodeStore: false,
      sessionIdEnv: "OPENCODE_SESSION_ID",
      usageBaseURL: "https://opencode.ai/zen/go/v1",
      usageEnabled: true,
      userAgent: undefined,
    });
    // Every volatile key answers a node; debug is a plain value.
    expect(
      Object.entries(row)
        .filter(([, value]) => hasGet(value))
        .map(([key]) => key)
        .toSorted()
    ).toStrictEqual(
      Object.entries(SCHEMA)
        .filter(([key, pin]) => pin.volatile && key !== "debugFile")
        .map(([key]) => key)
        .toSorted()
    );
    expect(hasGet(row.debug)).toBe(false);

    // The schema does not know the option sets: a typo passes it, and the
    // resolver is what degrades it.
    expect(unwrap(load({ endpoint: "typo" }).endpoint)).toBe("typo");
    expect(() => load({ keySource: "live" })).not.toThrow();
    // A wrong type fails the load.
    expect(() => load({ keySource: 42 })).toThrow();
    expect(() => load({ debug: "x" })).toThrow();
    expect(() => load({ providers: "a" })).toThrow();
    // An unknown key does not.
    expect(() => load({ noSuchSetting: 1 })).not.toThrow();
  });

  it("the resolver: every key of an empty row, and each kind's degradation", () => {
    const empty = resolveConfig({});
    expect(Object.keys(empty)).toHaveLength(19);
    expect(empty).toStrictEqual(RESOLVED_EMPTY);

    const resolved = (key: string, value: unknown): unknown =>
      Reflect.get(resolveConfig({ [key]: value } as PluginConfig), key);

    for (const key of BOOLEAN_KEYS) {
      const fallback = RESOLVED_EMPTY[key];
      for (const junk of ["yes", 1, null]) {
        expect(resolved(key, junk), `${key} = ${String(junk)}`).toBe(fallback);
      }
      // A volatile node, holding the value the default is not: an unread
      // node would resolve to the fallback.
      expect(resolved(key, { get: () => !fallback }), key).toBe(!fallback);
      expect(resolved(key, !fallback), key).toBe(!fallback);
    }

    for (const key of STRING_KEYS) {
      const fallback = RESOLVED_EMPTY[key];
      for (const junk of ["", "   ", 42, null]) {
        expect(resolved(key, junk), `${key} = ${String(junk)}`).toBe(fallback);
      }
      expect(resolved(key, "  set  "), key).toBe("set");
      expect(resolved(key, { get: () => " node " }), key).toBe("node");
    }

    for (const [key, values] of Object.entries(CHOICE_KEYS)) {
      for (const value of values) {
        expect(resolved(key, value), key).toBe(value);
      }
      for (const junk of ["typo", "", 42]) {
        expect(resolved(key, junk), `${key} = ${String(junk)}`).toBe("auto");
      }
      expect(resolved(key, { get: () => values.at(-1) }), key).toBe(
        values.at(-1)
      );
    }

    expect(resolved("gatewayUrls", [])).toStrictEqual(
      RESOLVED_EMPTY.gatewayUrls
    );
    expect(resolved("gatewayUrls", [" "])).toStrictEqual(
      RESOLVED_EMPTY.gatewayUrls
    );
    expect(resolved("gatewayUrls", [" a "])).toStrictEqual(["a"]);
    expect(resolved("gatewayUrls", { get: () => [" a "] })).toStrictEqual([
      "a",
    ]);
    expect(resolved("providers", { get: () => ["r"] })).toStrictEqual(
      new Set(["opencode", "opencode-go", "r"])
    );
    expect(resolved("providers", ["x"])).toStrictEqual(
      new Set(["opencode", "opencode-go", "x"])
    );
    expect(resolved("providers", [])).toStrictEqual(
      new Set(["opencode", "opencode-go"])
    );

    // Strict: the hand-written object also carried `credentialOrg:
    // undefined`, which the derived one, holding only the rows with a
    // default, does not (a named edit; see the plan's P8 block).
    expect(CONFIG_DEFAULTS).toStrictEqual({
      debug: false,
      endpoint: "auto",
      enrichModels: true,
      freeModelMarker: "free",
      gatewayUrls: ["opencode.ai/zen", "opencode.ai/inference"],
      injectCoreTools: true,
      injectOriginHeaders: true,
      injectProject: true,
      injectUserAgent: true,
      keySource: "auto",
      originClient: "cli",
      providers: ["opencode", "opencode-go"],
      readOpencodeStore: false,
      sessionIdEnv: "OPENCODE_SESSION_ID",
      usageBaseURL: "https://opencode.ai/zen/go/v1",
      usageEnabled: true,
    });
  });

  it("the card: field specs, config-only knobs and draft conversions", () => {
    expect(CARD_FIELDS).toStrictEqual([
      {
        field: "endpoint",
        group: "groupAccess",
        hintKey: "endpointHint",
        kind: "select",
        labelKey: "endpoint",
        options: [
          { labelKey: "endpointAuto", value: "auto" },
          { labelKey: "endpointLegacy", value: "legacy" },
          { labelKey: "endpointModern", value: "modern" },
        ],
      },
      {
        field: "keySource",
        group: "groupAccess",
        hintKey: "keySourceHint",
        kind: "select",
        labelKey: "keySource",
        options: [
          { labelKey: "keySourceAuto", value: "auto" },
          { labelKey: "keySourceRequest", value: "request" },
          { labelKey: "keySourceConfigured", value: "configured" },
        ],
      },
      {
        field: "readOpencodeStore",
        group: "groupAccess",
        hintKey: "readOpencodeStoreHint",
        kind: "boolean",
        labelKey: "readOpencodeStore",
      },
      {
        field: "injectUserAgent",
        group: "groupRequests",
        hintKey: "injectUserAgentHint",
        kind: "boolean",
        labelKey: "injectUserAgent",
      },
      {
        field: "injectOriginHeaders",
        group: "groupRequests",
        hintKey: "injectOriginHeadersHint",
        kind: "boolean",
        labelKey: "injectOriginHeaders",
      },
      {
        field: "injectProject",
        group: "groupRequests",
        hintKey: "injectProjectHint",
        kind: "boolean",
        labelKey: "injectProject",
      },
      {
        field: "enrichModels",
        group: "groupModels",
        hintKey: "enrichModelsHint",
        kind: "boolean",
        labelKey: "enrichModels",
      },
      {
        field: "injectCoreTools",
        group: "groupModels",
        hintKey: "injectCoreToolsHint",
        kind: "boolean",
        labelKey: "injectCoreTools",
      },
      {
        field: "usageEnabled",
        group: "groupQuota",
        hintKey: "usageEnabledHint",
        kind: "boolean",
        labelKey: "usageEnabled",
      },
    ]);

    expect(CONFIG_ONLY_FIELDS).toStrictEqual([
      {
        field: "credentialOrg",
        reason:
          "the org an account credential belongs to; a login through this plugin stores it with the token, so the row is for a token that came from elsewhere and has no UI to belong to",
      },
      {
        field: "debug",
        reason:
          "diagnostic console logging of streamed calls, not a behaviour a user tunes in the UI",
      },
      {
        field: "debugFile",
        reason:
          "the JSONL file both debug halves append to; naming it writes the file whether or not debug is on, and a server-side path is a deployment fact rather than a card control",
      },
      {
        field: "userAgent",
        reason:
          "literal User-Agent override; the default is the canonical CLI string",
      },
      {
        field: "originClient",
        reason:
          "literal x-opencode-client value; the default ('cli') is what the gateway expects",
      },
      {
        field: "sessionIdEnv",
        reason: "names an env var only a caller-supplied session id would use",
      },
      {
        field: "freeModelMarker",
        reason:
          "model-id substring; 'free' tracks the vendor's ids, '*' forces the fallback",
      },
      {
        field: "providers",
        reason:
          "route ids whose turns are decorated; both planes are always included, so only a relay route needs adding",
      },
      {
        field: "gatewayUrls",
        reason: "URL substrings; only a mirror or relay needs to change them",
      },
      {
        field: "usageBaseURL",
        reason: "endpoint override; auto-discovered from the composition",
      },
    ]);

    expect(SPECS.map((spec) => spec.field)).toStrictEqual([
      "endpoint",
      "keySource",
      "readOpencodeStore",
      "injectUserAgent",
      "injectOriginHeaders",
      "injectProject",
      "enrichModels",
      "injectCoreTools",
      "usageEnabled",
    ]);
    for (const [index, spec] of SPECS.entries()) {
      const entry = CARD_FIELDS[index];
      if (entry?.kind === "boolean") {
        expect(spec.format(true), spec.field).toBe("true");
        expect(spec.format(false), spec.field).toBe("false");
        expect(spec.format("x"), spec.field).toBe("");
        expect(spec.parse(" TRUE "), spec.field).toStrictEqual({
          kind: "set",
          value: true,
        });
        expect(spec.parse("false"), spec.field).toStrictEqual({
          kind: "set",
          value: false,
        });
        expect(spec.parse(""), spec.field).toStrictEqual({ kind: "clear" });
        expect(spec.parse("maybe"), spec.field).toBeUndefined();
      } else {
        expect(entry?.kind, spec.field).toBe("select");
        for (const option of entry?.options ?? []) {
          expect(spec.parse(option.value), spec.field).toStrictEqual({
            kind: "set",
            value: option.value,
          });
        }
        expect(spec.parse(""), spec.field).toStrictEqual({ kind: "clear" });
        expect(spec.parse("hand-edited"), spec.field).toBeUndefined();
        expect(spec.format(42), spec.field).toBe("");
      }
    }
  });

  it("the copy keys: the full list, in both languages", () => {
    // 104 through P10a; P10b adds the review's nine (`catalogLastError` and
    // the eight `unserved*` keys).
    expect(LIVE_KEYS).toHaveLength(113);
    const expected = [...LIVE_KEYS, "appliesOnReapply"].toSorted();
    expect(Object.keys(en).toSorted()).toStrictEqual(expected);
    expect(Object.keys(zh).toSorted()).toStrictEqual(expected);
    for (const key of DELETED_IN_P8) {
      expect(Object.keys(en)).not.toContain(key);
      expect(Object.keys(zh)).not.toContain(key);
    }
    for (const entry of CARD_FIELDS) {
      const keys = [
        entry.labelKey,
        entry.hintKey,
        entry.group,
        ...(entry.options ?? []).map((option) => option.labelKey),
      ];
      for (const key of keys) {
        expect(LIVE_KEYS, entry.field).toContain(key);
      }
    }
  });

  it("the config types keep their keys and value types (compile-time)", () => {
    // Optionality is normalised away here, so this says what each key holds;
    // the modifiers are pinned below.
    type Defined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
    type Exact<A, B> = [A] extends [B]
      ? [B] extends [A]
        ? true
        : false
      : false;
    interface ExpectedRaw {
      credentialOrg: string;
      debug: boolean;
      debugFile: string;
      endpoint: "auto" | "legacy" | "modern";
      enrichModels: boolean;
      freeModelMarker: string;
      gatewayUrls: string[];
      injectCoreTools: boolean;
      injectOriginHeaders: boolean;
      injectProject: boolean;
      injectUserAgent: boolean;
      keySource: "auto" | "request" | "configured";
      originClient: string;
      providers: string[];
      readOpencodeStore: boolean;
      sessionIdEnv: string;
      usageBaseURL: string;
      usageEnabled: boolean;
      userAgent: string;
    }
    interface ExpectedResolved extends Omit<
      ExpectedRaw,
      "gatewayUrls" | "providers"
    > {
      gatewayUrls: string[];
      providers: Set<string>;
    }
    const raw: Exact<Defined<PluginConfig>, ExpectedRaw> = true;
    const resolved: Exact<
      Defined<ResolvedPluginConfig>,
      ExpectedResolved
    > = true;
    // The modifiers `Defined` normalises away, pinned on their own. The
    // derived resolved type makes the three keys without a default optional
    // and every key mutable; the hand-written one had `credentialOrg` required
    // (as `string | undefined`) and it and `readOpencodeStore` readonly. Both
    // loosen the type, so no reader or writer breaks (a named edit; see the
    // plan's P8 block).
    type OptionalKeys<T> = {
      [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? never : K;
    }[keyof T];
    type Mutable<O> = { -readonly [P in keyof O]: O[P] };
    // The one check TypeScript has that tells `readonly` apart: two generic
    // signatures are identical only when the types they test are.
    type Same<X, Y> =
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the identity check's generic is never read, by design.
      (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2
        ? true
        : false;
    type ReadonlyKeys<T> = {
      [K in keyof T]-?: Same<Pick<T, K>, Mutable<Pick<T, K>>> extends true
        ? never
        : K;
    }[keyof T];
    const rawOptional: Exact<
      OptionalKeys<PluginConfig>,
      keyof ExpectedRaw
    > = true;
    const resolvedOptional: Exact<
      OptionalKeys<ResolvedPluginConfig>,
      "credentialOrg" | "debugFile" | "userAgent"
    > = true;
    const rawMutable: Exact<ReadonlyKeys<PluginConfig>, never> = true;
    const resolvedMutable: Exact<
      ReadonlyKeys<ResolvedPluginConfig>,
      never
    > = true;
    // Known answers, so the two helpers cannot pass vacuously.
    const optionalRead: Exact<OptionalKeys<{ a?: 1; b: 2 }>, "a"> = true;
    const readonlyRead: Exact<
      ReadonlyKeys<{ readonly c: 3; d: 4 }>,
      "c"
    > = true;
    expect([
      raw,
      resolved,
      rawOptional,
      resolvedOptional,
      rawMutable,
      resolvedMutable,
      optionalRead,
      readonlyRead,
    ]).toStrictEqual([true, true, true, true, true, true, true, true]);
  });
});
