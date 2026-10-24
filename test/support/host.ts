/**
 * The real host, in-process: the harness the routing work is judged against.
 *
 * Two tiers, both built from the host packages this repository installs at the
 * versions `host-versions.ts` names (pi 1.1.0 patched, the `@deepseek-ai`
 * cluster at the published host's tag):
 *
 * - **Tier A** ({@link mountTierA}): a bare cordis `Context`, `LlmRuntime`, and
 *   `dsh-llm-pi-ai` mounted as a plugin with a `{ providers }` config, so its
 *   config is the schemastery instance and its fiber has `update()` and
 *   `restart()`. No loader, no profile, no files. It is the tier for the
 *   `internal/config` waterfall and pi-ai's credential paths: anything that
 *   needs a fiber and the registry, and nothing that reads a profile. Mirrors
 *   the harness's own `llm/llm-pi-ai/tests/egress.spec.ts:33-47`.
 * - **Tier B** ({@link bootTierB}): dsh-app-boot's `boot()` with a temporary
 *   HOME, a test bundle and a profile patch, exactly as the harness's
 *   `experimental/speech-to-text/tests/configuration.spec.ts:12-33` boots one
 *   (`initProfile`, `readProfilePatches`, `root.provide("profileContext")`).
 *   It is the tier for the config editor, `settings.describe`, the loader's
 *   volatile commit, and the characterization of the plugin as it ships:
 *   everything that reads the loader's entries or writes the profile YAML.
 *
 * **Tier B's rows carry PACKAGE names, not `cordis:` builtins.** The five host
 * rows (`llm`, `llm-pi-ai`, `config-editor`, `settings`, and this plugin) are
 * named `@deepseek-ai/dsh-llm` … `dsh-opencode-patch`, and a stub module loader
 * on `root.loader.internal` resolves those names to the statically imported
 * namespaces — the harness's own pattern for a composition test
 * (`llm/llm-pi-ai/tests/loader-composition.spec.ts:62-79`). A builtin row is
 * named `cordis:<key>` (the loader's `vendor/loader/src/config/tree.ts:112-115`),
 * and the plugin's default host-module source finds pi-ai's entry by
 * `options.name === "@deepseek-ai/dsh-llm-pi-ai"` (`piAiEntry` in
 * `src/host/host-modules.ts`), so a builtin-named row would silently leave the
 * route claim without pi-ai's module and hand the planes back from everything
 * this harness characterizes.
 *
 * **Tier B fixes the apply order.** The loader starts rows in parallel, and the
 * stub loader resolves every import at once, so which of pi-ai and the plugin
 * applies first would otherwise be an accident of row order. It matters: the
 * route claim restarts pi-ai once when pi-ai applied first, and not at all
 * when the plugin did.
 * The default is `plugin-first`, the order measured on the published binary
 * ({@link ApplyOrder}); `pi-ai-first` is the other one. The held row is
 * released when the first row's `apply` returns OR its fiber settles in any
 * state, so a first row whose config fails to resolve leaves the boot to
 * finish with that fiber FAILED instead of hanging it.
 *
 * **Nothing here reads the process environment.** Both tiers provide a fake
 * `credentials` service ({@link fakeCredentials}) and a launch-environment
 * snapshot ({@link fakeLaunchEnvironment}) on the root, which is where pi-ai
 * looks first (`launchEnvironmentOf` reads `ctx.get("launchEnvironment")`
 * before it falls back to `process.env`). The plugin itself still reads
 * `process.env.OPENCODE_API_KEY`/`OPENCODE_GO_API_KEY` in its fetch patch and
 * its quota discovery (`src/fetch-patch.ts`, `src/go-discovery.ts`), so tier B blanks either
 * one a contributor's shell exports for the life of the boot and restores it
 * on dispose: the suite measures the keyless deployment whatever the shell
 * holds.
 *
 * **Offline.** {@link recordingFetch} answers every `opencode.ai` request with a
 * 401 and refuses every other host. Install it with `vi.stubGlobal("fetch", …)`
 * BEFORE mounting the plugin — its fetch patch captures `globalThis.fetch` at
 * effect time (`installFetchPatch` in `src/lifecycle.ts`) — and restore it with
 * `vi.unstubAllGlobals()` AFTER disposal, or the patch's own restore check
 * leaves the stub in place.
 *
 * Every builder returns a `dispose` that the caller runs in a `finally` or an
 * `afterEach`.
 *
 * @module test/support/host
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  type Entry,
  interpolate,
  type ModuleLoaderV2,
} from "@deepseek-ai/cordis-plugin-loader";
import {
  boot,
  initProfile,
  type ProfileContext,
  readProfilePatches,
} from "@deepseek-ai/dsh-app-boot";
import { ConfigEditor } from "@deepseek-ai/dsh-config-editor";
import {
  assertUsableApiKey,
  LlmError,
  LlmRuntime,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import Settings from "@deepseek-ai/dsh-settings";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";

import {
  apply,
  Config,
  type HostLibraries,
  type HostModuleSource,
  inject,
  name,
  type PiAiModule,
  replaceHostModuleSource,
} from "./src.ts";

/** The package name the plugin looks pi-ai up by (`PI_AI_PACKAGE` in `src/host/host-modules.ts`). */
export const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The `llm` service as the tests read it, private registry included. */
export type HostLlm = Context["llm"];

/** One registry row, as `LlmRuntime`'s private `adapters` map holds it. */
export interface RegistryRow {
  readonly adapter: {
    readonly constructor: { readonly name: string };
    readonly [key: string]: unknown;
  };
  readonly provider: { readonly id: string; readonly name: string };
  readonly retryPolicy: unknown;
}

/**
 * The registry map. Private in the type, readable at runtime, and the only way
 * to see a route `listProviders()` hides.
 */
export const adaptersOf = (llm: HostLlm): Map<string, RegistryRow> =>
  (llm as unknown as { adapters: Map<string, RegistryRow> }).adapters;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One call the fake credentials service answered, values never included. */
export type CredentialCall = readonly [method: string, key: string];

/** What {@link fakeCredentials} is seeded with. */
export interface CredentialSeed {
  /**
   * A log shared with {@link fakeLaunchEnvironment}: each call appends
   * `<method>:<key>` here too, so a test can order a credentials call against
   * an environment read on one clock.
   */
  readonly sharedLog?: string[];
  /** Reference values by name, e.g. `{ OPENCODE_API_KEY: "k" }`. */
  readonly refs?: Readonly<Record<string, string>>;
  /** Records by joined key, e.g. `{ "llm-pi-ai/opencode": { kind: "api-key", key: "k" } }`. */
  readonly records?: Readonly<Record<string, unknown>>;
}

/** The fake, with the log a test reads. */
export interface FakeCredentials {
  readonly calls: CredentialCall[];
  readonly service: Record<string, (...args: never[]) => unknown>;
}

/**
 * A `credentials` service over two in-memory maps: references (the
 * `OPENCODE_API_KEY` form) and records (the `llm-pi-ai/opencode` form). It
 * implements the surface pi-ai and the settings forms read, and logs every
 * method with its key, so a test can assert which key the host asked for.
 *
 * @param seed - the references and records it starts with.
 * @returns the service and its call log.
 */
export const fakeCredentials = (seed: CredentialSeed = {}): FakeCredentials => {
  const refs = new Map(Object.entries(seed.refs ?? {}));
  const records = new Map(Object.entries(seed.records ?? {}));
  const calls: CredentialCall[] = [];
  const log = (method: string, key: string): void => {
    calls.push([method, key]);
    seed.sharedLog?.push(`${method}:${key}`);
  };
  const service = {
    resolve: async (ref: string) => {
      log("resolve", ref);
      const value = refs.get(ref);
      return value === undefined || value.length === 0
        ? undefined
        : { source: "fake", value };
    },
    describe: async (ref: string) => {
      log("describe", ref);
      const configured = (refs.get(ref) ?? "").length > 0;
      return configured
        ? { configured, source: "fake", writable: true }
        : { configured, writable: true };
    },
    set: async (ref: string, value: string) => {
      log("set", ref);
      refs.set(ref, value);
    },
    unset: async (ref: string) => {
      log("unset", ref);
      refs.delete(ref);
    },
    readRecord: async (key: string) => {
      log("readRecord", key);
      return records.get(key);
    },
    describeRecord: async (key: string) => {
      log("describeRecord", key);
      const record = records.get(key) as { kind?: string } | undefined;
      return record === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind: record.kind, writable: true };
    },
    listRecords: async () => {
      log("listRecords", "*");
      return [...records.entries()].map(([key, record]) => ({
        key,
        kind: (record as { kind?: string }).kind,
      }));
    },
    modifyRecord: async (
      key: string,
      mutate: (current: unknown) => Promise<unknown>
    ) => {
      log("modifyRecord", key);
      const next = await mutate(records.get(key));
      if (next !== undefined) {
        records.set(key, next);
      }
      return records.get(key);
    },
    deleteRecord: async (key: string) => {
      log("deleteRecord", key);
      records.delete(key);
    },
  };
  return {
    calls,
    service: service as unknown as FakeCredentials["service"],
  };
};

/** The fake launch environment, with the names it was asked for. */
export interface FakeLaunchEnvironment {
  readonly reads: string[];
  readonly snapshot: {
    readonly get: (
      name: string
    ) => { value: string; source: "process" } | undefined;
    readonly getFrom: (
      name: string,
      sources: readonly string[]
    ) => { value: string; source: "process" } | undefined;
  };
}

/**
 * A launch-environment snapshot over a plain record, in the shape
 * `launchEnvironmentOf` hands back (`get`, `getFrom`). It stands in for the
 * launcher's snapshot so the host never falls back to `process.env`.
 *
 * @param values - the variables the "process" layer holds.
 * @param sharedLog - a log shared with {@link fakeCredentials}; each read
 *   appends `env:<name>`.
 * @returns the snapshot and the log of names read.
 */
export const fakeLaunchEnvironment = (
  values: Readonly<Record<string, string>> = {},
  sharedLog?: string[]
): FakeLaunchEnvironment => {
  const reads: string[] = [];
  const lookup = (key: string) => {
    reads.push(key);
    sharedLog?.push(`env:${key}`);
    const value = values[key];
    return value === undefined
      ? undefined
      : { source: "process" as const, value };
  };
  return {
    reads,
    snapshot: {
      get: lookup,
      getFrom: (key, sources) =>
        sources.includes("process") ? lookup(key) : undefined,
    },
  };
};

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** One request the recording fetch saw. Credential header VALUES are never kept. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly model: string | undefined;
  /** Lower-cased names; a credential header's value is replaced by its length. */
  readonly headers: Readonly<Record<string, string | number>>;
}

/** The hosts the recording fetch answers; everything else is refused. */
const GATEWAY_HOSTS = new Set(["opencode.ai", "models.opencode.ai"]);

/** Headers whose value is a secret: recorded by length only. */
const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

/** The 401 every gateway request gets unless the caller supplies a responder. */
export const offlineAuthResponse = (): Response =>
  Response.json(
    { error: { message: "probe: offline", type: "AuthError" } },
    { status: 401 }
  );

/** A fetch replacement and what it recorded. */
export interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
}

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const recordHeaders = (
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Record<string, string | number> => {
  const merged = new Headers(input instanceof Request ? input.headers : {});
  for (const [key, value] of new Headers(init?.headers ?? {})) {
    merged.set(key, value);
  }
  const out: Record<string, string | number> = {};
  for (const [key, value] of merged) {
    out[key] = SECRET_HEADERS.has(key) ? value.length : value;
  }
  return out;
};

const bodyTextOf = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<string | undefined> => {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (init?.body instanceof Uint8Array) {
    return new TextDecoder().decode(init.body);
  }
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * A fetch that records every gateway request and answers it offline.
 *
 * @param options.respond - the answer for a gateway request (default: a 401).
 * @returns the fetch and its log.
 */
export const recordingFetch = (
  options: {
    readonly respond?: (request: RecordedRequest) => Response;
  } = {}
): RecordingFetch => {
  const requests: RecordedRequest[] = [];
  const respond = options.respond ?? offlineAuthResponse;
  const replacement = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = urlOf(input);
    let host = "";
    try {
      ({ hostname: host } = new URL(url));
    } catch {
      host = "";
    }
    if (!GATEWAY_HOSTS.has(host)) {
      throw new TypeError(
        `host harness: refused a request to ${host || "a non-URL input"}`
      );
    }
    const text = await bodyTextOf(input, init);
    let model: string | undefined;
    try {
      const parsed: unknown = JSON.parse(text ?? "");
      const candidate = (parsed as { model?: unknown } | null)?.model;
      model = typeof candidate === "string" ? candidate : undefined;
    } catch {
      model = undefined;
    }
    const request: RecordedRequest = {
      headers: recordHeaders(input, init),
      method: (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase(),
      model,
      url,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: replacement as typeof fetch, requests };
};

// ---------------------------------------------------------------------------
// The S0 fixture
// ---------------------------------------------------------------------------

/**
 * The profile run S0 measured: on each plane one known model per protocol plus
 * the models pi 1.1.0 lacks, and a sibling pi-ai route that is not a plane.
 * `deepseek`'s base is loopback port 9 (discard), so nothing reaches it.
 */
export const S0_PROFILE = {
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: "http://127.0.0.1:9/v1",
  },
  opencode: {
    apiKeyEnv: "OPENCODE_API_KEY",
    models: [
      { id: "deepseek-v4-pro" },
      { id: "gpt-5.4" },
      { id: "claude-haiku-5-5" },
      { id: "gemini-3-flash" },
      { contextWindow: 400_000, id: "gpt-5.3-codex-spark", name: "My Spark" },
    ],
  },
  "opencode-go": {
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    models: [
      { id: "deepseek-v4-pro" },
      { id: "muse-spark-1.2-contributor" },
      { id: "minimax-m3" },
      { id: "gemini-4-argon-contributor" },
      { id: "minimax-m3.1-flash" },
    ],
  },
} as const;

/**
 * A DECLARED id that neither pi 1.1.0 nor the plugin's catalog describes (G1's
 * second class, beside the gap ids the plugin's catalog still describes).
 */
export const UNKNOWN_ID = "not-in-any-catalog";

/**
 * The characterization profile: {@link S0_PROFILE} with {@link UNKNOWN_ID}
 * declared LAST on each plane, so the strict check still names each plane's
 * stored gap id first. The contract tests keep plain S0, whose rows the
 * declared unknown id would only blur.
 */
export const CHARACTERIZED_PROFILE = {
  ...S0_PROFILE,
  opencode: {
    ...S0_PROFILE.opencode,
    models: [...S0_PROFILE.opencode.models, { id: UNKNOWN_ID }],
  },
  "opencode-go": {
    ...S0_PROFILE["opencode-go"],
    models: [...S0_PROFILE["opencode-go"].models, { id: UNKNOWN_ID }],
  },
} as const;

/** The plane routes pi-ai serves today. */
export const PLANES = ["opencode", "opencode-go"] as const;
export type Plane = (typeof PLANES)[number];

/** A fresh, mutable copy of {@link S0_PROFILE}. */
export const s0Providers = (): Record<string, Record<string, unknown>> =>
  structuredClone(S0_PROFILE) as unknown as Record<
    string,
    Record<string, unknown>
  >;

/** A fresh, mutable copy of {@link CHARACTERIZED_PROFILE}. */
export const characterizedProviders = (): Record<
  string,
  Record<string, unknown>
> =>
  structuredClone(CHARACTERIZED_PROFILE) as unknown as Record<
    string,
    Record<string, unknown>
  >;

/** The characterized model ids per plane, in declaration order. */
export const CHARACTERIZED_MODELS: Readonly<Record<Plane, readonly string[]>> =
  {
    opencode: CHARACTERIZED_PROFILE.opencode.models.map((model) => model.id),
    "opencode-go": CHARACTERIZED_PROFILE["opencode-go"].models.map(
      (model) => model.id
    ),
  };

/**
 * How a characterization row is tagged, so a later phase flips named rows:
 * `KNOWN_DEFECT` is wrong today and a phase fixes it, `INTENDED_CHANGE` is
 * right today and a phase changes it on purpose, `BASELINE` must survive.
 */
export type RowTag = "BASELINE" | "INTENDED_CHANGE" | "KNOWN_DEFECT";

/**
 * The three facets a row records, each tagged on its own: one model can be
 * right on the wire and wrong in validation (Zen gpt-5.3-codex-spark is).
 * `info` is `context` + `efforts`, `callConfig` the verdict, `wire` is
 * `sent` + `finish`.
 */
export type RowFacet = "callConfig" | "info" | "wire";

/** What TODAY's plugin does with one characterized model on pi 1.1.0, as measured. */
export interface TodayRow {
  readonly tags: Readonly<Record<RowFacet, RowTag>>;
  /**
   * `resolveModelInfo`: its context window and effort ids in order, or the
   * error code it rejects with.
   */
  readonly info:
    | { readonly context: number; readonly efforts: readonly string[] }
    | { readonly error: string };
  /** `resolveCallConfig`: `"ok"`, or the error code it rejects with. */
  readonly callConfig: "ok" | "INVALID_CONFIG";
  /** The gateway URLs one turn sent, in order (the catalog read excluded). */
  readonly sent: readonly string[];
  /** The code on the turn's final `finish` chunk. */
  readonly finish: string;
}

const ZEN = "https://opencode.ai";

/** Shorthand for a row's facet tags. */
const tags = (
  info: RowTag,
  callConfig: RowTag,
  wire: RowTag
): Readonly<Record<RowFacet, RowTag>> => ({ callConfig, info, wire });

const B = "BASELINE";

/**
 * What the plugin does with each characterized model on pi 1.1.0, measured in
 * tier B with {@link CHARACTERIZED_PROFILE} and a key stored for each plane,
 * and shared with the binary e2e so the two cannot drift. Each facet carries
 * its own tag, and the characterization generates one test per row and facet
 * titled with it. P-T1b recorded these against the hidden-route workaround;
 * P-R1 (the plugin owns the plane routes) flipped the fourteen
 * `KNOWN_DEFECT`/`INTENDED_CHANGE` facets its PR body names to `BASELINE`, so
 * every facet here is one no later phase may move — except that the `fix:`
 * that flips `AUTO_ENDPOINT_FAMILY` on P-R2's measured evidence
 * (`docs/redirect-planes.md` §13) may move the endpoint-family part of a wire
 * facet, re-tagging each one it moves and naming it in its PR body.
 *
 * `context` and `efforts` follow D17 and D1: the user's row first (Zen
 * gpt-5.3-codex-spark's 400000), then the bundled catalog
 * (`src/catalog-data.ts`), which the nightly refresh rewrites. A fixture-sanity
 * case in `test/host-characterization.test.ts` derives each row's context and
 * effort ids the same way, so a refresh that moves a fixture model fails there
 * by name — update the row here. The binary e2e reads the same table, and its
 * job runs on a PR only when this file is in its path scope
 * (`.github/workflows/ci.yml`, `e2e-host`), which it is.
 */
export const S0_TODAY = {
  /**
   * `listModels` before any turn, with the keys stored: every declared id
   * (D21). The keyless boot is `test/host-planes.test.ts`'s declared-listing
   * case.
   */
  listingBeforeTurn: CHARACTERIZED_MODELS,
  /** `listModels` once a turn ran: the same declared ids. */
  listingAfterTurn: CHARACTERIZED_MODELS,
  rows: {
    "opencode/deepseek-v4-pro": {
      callConfig: "ok",
      info: { context: 1_000_000, efforts: ["high", "max"] },
      finish: "AUTH",
      sent: [`${ZEN}/inference/openai/v1/chat/completions`],
      tags: tags(B, B, B),
    },
    "opencode/gpt-5.4": {
      callConfig: "ok",
      info: { context: 1_050_000, efforts: ["low", "medium", "high", "xhigh"] },
      finish: "AUTH",
      sent: [`${ZEN}/inference/openai/v1/responses`],
      tags: tags(B, B, B),
    },
    "opencode/claude-haiku-5-5": {
      callConfig: "ok",
      info: {
        context: 1_000_000,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      finish: "AUTH",
      sent: [`${ZEN}/inference/anthropic/v1/messages?beta=true`],
      tags: tags(B, B, B),
    },
    "opencode/gemini-3-flash": {
      callConfig: "ok",
      info: {
        context: 1_048_576,
        efforts: ["minimal", "low", "medium", "high"],
      },
      finish: "PI_AI_ERROR",
      sent: [
        `${ZEN}/inference/google/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse`,
      ],
      tags: tags(B, B, B),
    },
    // The user's row (name "My Spark", contextWindow 400000) wins (D17).
    "opencode/gpt-5.3-codex-spark": {
      callConfig: "ok",
      info: { context: 400_000, efforts: ["low", "medium", "high", "xhigh"] },
      finish: "AUTH",
      sent: [`${ZEN}/inference/openai/v1/responses`],
      tags: tags(B, B, B),
    },
    // Neither catalog describes it: served as completions on the defaults (D15, D16).
    "opencode/not-in-any-catalog": {
      callConfig: "ok",
      finish: "AUTH",
      info: { context: 262_144, efforts: [] },
      sent: [`${ZEN}/inference/openai/v1/chat/completions`],
      tags: tags(B, B, B),
    },
    "opencode-go/deepseek-v4-pro": {
      callConfig: "ok",
      info: { context: 1_000_000, efforts: ["high", "max"] },
      finish: "AUTH",
      sent: [`${ZEN}/inference/go/openai/v1/chat/completions`],
      tags: tags(B, B, B),
    },
    "opencode-go/muse-spark-1.2-contributor": {
      callConfig: "ok",
      info: {
        context: 1_048_576,
        efforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
      finish: "AUTH",
      sent: [`${ZEN}/inference/go/openai/v1/responses`],
      tags: tags(B, B, B),
    },
    // A toggle-only model on Messages: Off / On (D1).
    "opencode-go/minimax-m3": {
      callConfig: "ok",
      info: { context: 1_000_000, efforts: ["off", "high"] },
      finish: "AUTH",
      sent: [`${ZEN}/inference/go/anthropic/v1/messages?beta=true`],
      tags: tags(B, B, B),
    },
    "opencode-go/gemini-4-argon-contributor": {
      callConfig: "ok",
      info: { context: 1_048_576, efforts: ["low", "medium", "high"] },
      finish: "PI_AI_ERROR",
      sent: [
        `${ZEN}/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse`,
      ],
      tags: tags(B, B, B),
    },
    "opencode-go/minimax-m3.1-flash": {
      callConfig: "ok",
      info: {
        context: 1_000_000,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      finish: "AUTH",
      sent: [`${ZEN}/inference/go/openai/v1/chat/completions`],
      tags: tags(B, B, B),
    },
    "opencode-go/not-in-any-catalog": {
      callConfig: "ok",
      finish: "AUTH",
      info: { context: 262_144, efforts: [] },
      sent: [`${ZEN}/inference/go/openai/v1/chat/completions`],
      tags: tags(B, B, B),
    },
  } satisfies Record<string, TodayRow>,
  /**
   * What appending a new id to `opencode` answers on pi-ai ALONE (the plugin
   * disposed) while the plane stores a gap id: pi-ai's strict check names the
   * STORED gap id, whatever is being saved. With the plugin, any id saves (D15).
   */
  saveBlockedByStoredGap:
    /provider "opencode" model "gpt-5\.3-codex-spark" needs an api/u,
} as const;

/** The id the save rows try to add: unknown to every catalog, and not declared. */
export const SAVE_CANDIDATE = "not-a-real-model";

/**
 * The ids on `opencode` that pi 1.1.0 cannot place: the stored gap id and the
 * declared unknown id. The save sequence (in-process, and the probe's
 * `PROBE_SAVE_DROP`) removes them before saving {@link SAVE_CANDIDATE}.
 */
export const ZEN_UNDESCRIBED = ["gpt-5.3-codex-spark", UNKNOWN_ID] as const;

/**
 * The rows for an apply order. With the plugin owning the planes, the apply
 * order no longer moves any facet, so both orders answer `S0_TODAY.rows`. Only
 * the in-process characterization calls it, once per order it boots (the binary
 * e2e reads `S0_TODAY.rows` directly); an order this function does not know is
 * refused rather than read as one it does.
 *
 * @param order - the apply order.
 * @returns the rows, keyed `<route>/<model>`.
 */
export const todayRowsFor = (
  order: ApplyOrder
): Readonly<Record<keyof typeof S0_TODAY.rows, TodayRow>> => {
  // Exhaustive on purpose: a probe JSON with a missing or renamed field reads
  // `undefined` here.
  if (order !== "plugin-first" && order !== "pi-ai-first") {
    throw new Error(`todayRowsFor: unknown apply order ${String(order)}`);
  }
  return S0_TODAY.rows;
};

/**
 * Every {@link ApplyOrder}, for iterating {@link todayRowsFor}'s tables. Built
 * from a `Record` keyed by the union, so a member added to `ApplyOrder` and
 * missing here fails to compile rather than going unchecked.
 */
export const APPLY_ORDERS = Object.keys({
  "pi-ai-first": true,
  "plugin-first": true,
} satisfies Record<ApplyOrder, true>) as readonly ApplyOrder[];

const PI_DATA = new URL(
  "../../node_modules/@earendil-works/pi-ai/dist/providers/data/",
  import.meta.url
);

const piData = (plane: Plane): Record<string, Record<string, unknown>> =>
  JSON.parse(
    readFileSync(
      new URL(
        plane === "opencode" ? "opencode.json" : "opencode-go.json",
        PI_DATA
      ),
      "utf8"
    )
  ) as Record<string, Record<string, unknown>>;

/**
 * The protocol the installed pi's catalog files a model under on a plane, or
 * `undefined` when pi does not know it. The data is keyed by protocol, then
 * `chat:<id>`, so a fixture can check which of its ids are gaps on pi 1.1.0.
 *
 * @param plane - the plane route.
 * @param id - the model id.
 * @returns the protocol, or `undefined` for a gap.
 */
export const piKnows = (plane: Plane, id: string): string | undefined =>
  Object.entries(piData(plane)).find(([, models]) =>
    Object.hasOwn(models, `chat:${id}`)
  )?.[0];

// ---------------------------------------------------------------------------
// Waterfall helpers
// ---------------------------------------------------------------------------

/**
 * A fresh deep copy of a raw pi-ai config without the two plane entries. Pure:
 * it never touches its input, so it is safe on a frozen one.
 *
 * @param raw - the raw config, `{ providers }`.
 * @returns the copy.
 */
export const withoutPlanes = <T>(raw: T): T => {
  const copy = structuredClone(raw) as { providers?: Record<string, unknown> };
  if (copy.providers !== undefined && copy.providers !== null) {
    delete copy.providers.opencode;
    delete copy.providers["opencode-go"];
  }
  return copy as T;
};

/** Deep-freeze a value and everything under it. */
export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

/** One `internal/config` run the spy saw. */
export interface WaterfallRecord {
  readonly self: Fiber;
  readonly raw: unknown;
  /** `raw === this._config` at the moment the listener ran (F14). */
  readonly isCommit: boolean;
  readonly order: number;
}

/**
 * Record every `internal/config` run for one fiber, from a listener prepended
 * on `ctx` (so it is outermost among those registered before it).
 *
 * @param ctx - the context to register on (the root, or another plugin's).
 * @param fiber - the fiber whose runs are kept; omit to keep every run.
 * @returns the records, and the disposer.
 */
export const waterfallSpy = (
  ctx: Context,
  fiber?: () => Fiber | undefined
): { records: WaterfallRecord[]; dispose: ReturnType<Context["on"]> } => {
  const records: WaterfallRecord[] = [];
  const dispose = ctx.on(
    "internal/config",
    function recordRun(this: Fiber, raw: unknown, next: () => unknown) {
      const target = fiber?.();
      if (target === undefined || this === target) {
        records.push({
          isCommit: raw === (this as unknown as { _config: unknown })._config,
          order: records.length,
          raw,
          self: this,
        });
      }
      return next();
    },
    { prepend: true }
  );
  return { dispose, records };
};

/**
 * Poll the registry until every route is present: a route registers after
 * its owner's config resolves, which is asynchronous. For the two planes,
 * {@link waitForPlaneOwner} also waits for the plugin to be their owner.
 *
 * @param llm - the `llm` service.
 * @param ids - the routes to wait for.
 * @param deadlineMs - how long to wait before failing. The default sits well
 *   inside the 30 s a tier-B hook gets for the boot AND this wait, so a route
 *   that never registers fails by name rather than as a hook timeout.
 */
export const waitForRoutes = async (
  llm: HostLlm,
  ids: readonly string[],
  deadlineMs = 10_000
): Promise<void> => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const present = adaptersOf(llm);
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length === 0) {
      return;
    }
    if (Date.now() > until) {
      throw new Error(
        `host harness: routes never registered: ${missing.join(", ")}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
};

/**
 * Poll the registry until each plane is served by an adapter of class
 * `owner`: the plugin registers its plane adapter once its mount settles.
 *
 * @param llm - the `llm` service.
 * @param planes - the routes to wait for.
 * @param owner - the adapter's class name.
 * @param deadlineMs - how long to wait before failing by name.
 */
export const waitForPlaneOwner = async (
  llm: HostLlm,
  planes: readonly string[] = PLANES,
  owner = "PlaneAdapter",
  deadlineMs = 10_000
): Promise<void> => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const registry = adaptersOf(llm);
    const wrong = planes.filter(
      (plane) => registry.get(plane)?.adapter.constructor.name !== owner
    );
    if (wrong.length === 0) {
      return;
    }
    if (Date.now() > until) {
      throw new Error(
        `host harness: ${wrong.join(", ")} never came to ${owner} (${wrong
          .map(
            (plane) =>
              registry.get(plane)?.adapter.constructor.name ?? "unregistered"
          )
          .join(", ")})`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** The adapter class serving a route, or `undefined`. */
export const ownerOf = (llm: HostLlm, route: string): string | undefined =>
  adaptersOf(llm).get(route)?.adapter.constructor.name;

/** cordis `FiberState.UNLOADING`. */
const UNLOADING_STATES: ReadonlySet<number> = new Set([5]);

/**
 * Count pi-ai's restarts from now on: every UNLOADING transition of a pi-ai
 * fiber that is not being disposed (a dispose clears `uid` first).
 *
 * @param root - the root context.
 * @returns the live count, and the disposer.
 */
export const piAiRestarts = (
  root: Context
): { readonly count: () => number; readonly dispose: () => void } => {
  let count = 0;
  const off = root.on("internal/status", (fiber: Fiber) => {
    if (
      fiber.runtime?.name === "llm-pi-ai" &&
      UNLOADING_STATES.has(fiber.state) &&
      fiber.uid !== null
    ) {
      count += 1;
    }
  });
  return {
    count: () => count,
    dispose: () => {
      off();
    },
  };
};

/**
 * Every line any logger writes from now on, at every level.
 *
 * cordis's own exporter buffers only up to `info` (its default threshold, so
 * a `warn` is never kept), and tier B adds no console exporter: nothing a
 * plugin logs reaches the console or the default buffer reliably. This
 * exporter takes every level, so an assertion about what was logged reads
 * what was actually logged. A case should log one line of its own through it
 * to prove the input is read.
 *
 * @param root - the host's root context.
 * @returns the lines (`<type> <name>: <args>`) and the exporter's removal.
 */
export const logLines = (
  root: Context
): { readonly lines: () => string[]; readonly dispose: () => void } => {
  const lines: string[] = [];
  const logger = root.logger as unknown as {
    exporter: (exporter: {
      levels: { default: number };
      export: (message: {
        type: string;
        name: string;
        args: unknown[];
      }) => void;
    }) => () => void;
  };
  const off = logger.exporter({
    export: (message) => {
      lines.push(
        `${message.type} ${message.name}: ${message.args.map(String).join(" ")}`
      );
    },
    levels: { default: 3 },
  });
  return {
    dispose: () => {
      off();
    },
    lines: () => [...lines],
  };
};

/**
 * The host modules from this repository's own install, statically imported:
 * what the plugin reads through its loader on a real host, handed in through
 * the seam where there is no loader (tier A).
 *
 * @returns the source.
 */
export const hostModulesForTests = (): HostModuleSource => {
  const libraries: HostLibraries = {
    apis: {
      "anthropic-messages": anthropicMessagesApi,
      "google-generative-ai": googleGenerativeAIApi,
      "openai-completions": openAICompletionsApi,
      "openai-responses": openAIResponsesApi,
    },
    assertUsableApiKey,
    builtinModels: (route) =>
      getBuiltinModels(route as never) as unknown as ReturnType<
        HostLibraries["builtinModels"]
      >,
    createProvider:
      createProvider as unknown as HostLibraries["createProvider"],
    interpolate: interpolate as HostLibraries["interpolate"],
    LlmError: LlmError as unknown as HostLibraries["LlmError"],
    opencodeAuth: opencodeProvider().auth,
    opencodeGoAuth: opencodeGoProvider().auth,
    resolveRetryPolicy:
      resolveRetryPolicy as unknown as HostLibraries["resolveRetryPolicy"],
    version: "1.1.0",
    withOpenCodeSessionHeader:
      withOpenCodeSessionHeader as unknown as HostLibraries["withOpenCodeSessionHeader"],
  };
  return {
    libraries: () => Promise.resolve(libraries),
    piAi: () => Promise.resolve(LlmPiAi as unknown as PiAiModule),
  };
};

/** One drained `llm.stream` call: the chunk types and the final finish. */
export interface DrainedStream {
  readonly types: string[];
  readonly finish:
    | { readonly kind: string | undefined; readonly code: string | undefined }
    | undefined;
  readonly error: string | undefined;
  /** The finish's failure message, when it carried one. */
  readonly failureMessage: string | undefined;
}

/**
 * Drive one turn through the host's own stream path and keep what it said.
 *
 * @param llm - the `llm` service.
 * @param provider - the route.
 * @param model - the model id.
 * @returns the drained stream.
 */
export const drainStream = async (
  llm: HostLlm,
  provider: string,
  model: string,
  extra: Readonly<Record<string, unknown>> = {}
): Promise<DrainedStream> => {
  const types: string[] = [];
  let finish: DrainedStream["finish"];
  let failed: string | undefined;
  let failureMessage: string | undefined;
  try {
    for await (const chunk of llm.stream({
      messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
      model,
      provider,
      signal: AbortSignal.timeout(10_000),
      ...extra,
    } as never)) {
      const typed = chunk as {
        type: string;
        reason?: {
          kind?: string;
          failure?: { code?: string; message?: string };
        };
      };
      types.push(typed.type);
      if (typed.type === "finish") {
        finish = {
          code: typed.reason?.failure?.code,
          kind: typed.reason?.kind,
        };
        failureMessage = typed.reason?.failure?.message;
      }
    }
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    failed = `${typeof failure.code === "string" ? `${failure.code} ` : ""}${String(failure.message ?? error)}`;
  }
  return { error: failed, failureMessage, finish, types };
};

// ---------------------------------------------------------------------------
// Tier A
// ---------------------------------------------------------------------------

/** What {@link mountTierA} takes. */
export interface TierAOptions {
  /** pi-ai's `providers` dict. */
  readonly providers: Record<string, unknown>;
  /** pi-ai's whole raw config, used as given instead of `{ providers }` (a frozen input). */
  readonly piConfig?: object;
  /**
   * Mount this plugin too, with this row config. Stub `fetch` first (its fetch
   * patch captures `globalThis.fetch` at effect time). Tier A has no loader,
   * so the plugin's default source cannot find pi-ai's module: the harness
   * swaps in {@link hostModulesForTests} (the `hostModules` option, `null` to
   * keep the default), which answers the statically imported modules, so the
   * route claim serves the planes here as it does on the real host.
   * Characterize the plugin as it ships in tier B.
   */
  readonly plugin?: Record<string, unknown>;
  readonly credentials?: FakeCredentials;
  readonly launchEnvironment?: FakeLaunchEnvironment;
  /** Runs on the root before pi-ai mounts (a listener to register first). */
  readonly before?: (ctx: Context) => void;
  /**
   * Where the plugin finds the host's modules. Tier A has no loader, so a
   * plugin mounted here reads them from {@link hostModulesForTests} by
   * default; `null` leaves the plugin's own default source in place.
   */
  readonly hostModules?: HostModuleSource | null;
}

/** A mounted tier A. */
export interface TierA {
  readonly ctx: Context;
  readonly llm: HostLlm;
  readonly piFiber: Fiber;
  readonly pluginFiber: Fiber | undefined;
  readonly credentials: FakeCredentials;
  readonly launchEnvironment: FakeLaunchEnvironment;
  readonly dispose: () => Promise<void>;
}

/**
 * A bare `Context` with `LlmRuntime` and pi-ai mounted as plugins.
 *
 * @param options - the providers, and the optional plugin config and fakes.
 * @returns the mount; the caller disposes it.
 */
export const mountTierA = async (options: TierAOptions): Promise<TierA> => {
  const ctx = new Context();
  const credentials = options.credentials ?? fakeCredentials();
  const launchEnvironment =
    options.launchEnvironment ?? fakeLaunchEnvironment();
  const restoreSource =
    options.plugin === undefined || options.hostModules === null
      ? (): void => {
          // The default source stands: nothing was replaced.
        }
      : replaceHostModuleSource(options.hostModules ?? hostModulesForTests());
  try {
    ctx.provide("credentials", credentials.service);
    ctx.provide("launchEnvironment", launchEnvironment.snapshot);
    await ctx.plugin(LlmRuntime);
    options.before?.(ctx);
    const piFiber: Fiber = await ctx.plugin(
      LlmPiAi as never,
      (options.piConfig ?? { providers: options.providers }) as never
    );
    let pluginFiber: Fiber | undefined;
    if (options.plugin !== undefined) {
      pluginFiber = await ctx.plugin(
        { apply, Config, inject, name } as never,
        options.plugin as never
      );
    }
    return {
      credentials,
      ctx,
      dispose: async () => {
        try {
          await ctx.fiber.dispose();
        } finally {
          restoreSource();
        }
      },
      launchEnvironment,
      llm: ctx.llm,
      piFiber,
      pluginFiber,
    };
  } catch (error) {
    try {
      await ctx.fiber.dispose();
    } finally {
      restoreSource();
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Tier B
// ---------------------------------------------------------------------------

/** The modules the stub loader resolves, by package name. */
const HOST_MODULES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["@deepseek-ai/dsh-llm", LlmRuntime],
  [PI_AI_PACKAGE, LlmPiAi],
  ["@deepseek-ai/dsh-config-editor", ConfigEditor],
  ["@deepseek-ai/dsh-settings", Settings],
  [name, { apply, Config, inject, name }],
]);

/**
 * The loader's module seam, answering only the five host rows. Any other
 * import is a composition this harness did not intend, so it throws. A value
 * may be a promise, which is how {@link orderedModules} holds one row back.
 *
 * @param modules - the namespaces (or promises of them) by specifier.
 * @returns the `ModuleLoaderV2` to put on `root.loader.internal`.
 */
export const stubModuleLoader = (
  modules: ReadonlyMap<string, unknown> = HOST_MODULES
): ModuleLoaderV2 => ({
  getOrCreateModuleJob(): never {
    throw new Error("unexpected module job creation");
  },
  import: async (specifier: string) => {
    if (!modules.has(specifier)) {
      throw new Error(`unexpected Loader import: ${specifier}`);
    }
    return await modules.get(specifier);
  },
  load(): never {
    throw new Error("unexpected module load");
  },
  loadCache: new Map() as never,
  register(): never {
    throw new Error("unexpected module hook registration");
  },
  resolveSync(): never {
    throw new Error("unexpected synchronous module resolution");
  },
  version: "v2",
});

/**
 * Which of pi-ai and this plugin APPLIES first. The loader starts rows in
 * parallel (F17), so on a real host the order is whatever module loading makes
 * it. Measured on the published binary: the plugin applies first, about 70 ms
 * before pi-ai registers its routes, because pi-ai's module is the heavier
 * import. The stub loader resolves every import at once, so the harness makes
 * the order explicit instead of inheriting row order.
 */
export type ApplyOrder = "pi-ai-first" | "plugin-first";

/** The fiber states a row settles in: ACTIVE, FAILED, DISPOSED (cordis `FiberState`). */
const SETTLED_STATES: ReadonlySet<number> = new Set([2, 3, 4]);

/** {@link orderedModules}' answer: the modules, and the hook that arms the fallback release. */
interface OrderedModules {
  readonly modules: ReadonlyMap<string, unknown>;
  /** Register, on the root, the release for a first row that never applies. */
  readonly watch: (root: Context) => void;
}

/**
 * The host modules with one of the two rows held back until the other's
 * `apply` has returned.
 *
 * A first row can also settle WITHOUT applying: cordis resolves a fiber's
 * config before it runs `apply` (`fiber.ts` `_reload`), so a config the
 * schema rejects leaves the fiber FAILED and `apply` never called. The held
 * import would then never resolve, the loader would wait on it for ever, and
 * `boot()` with it. So `watch` also releases the held row as soon as the first
 * row's fiber reports a settled state (`internal/status`), and the boot
 * finishes with that fiber FAILED — its error readable through
 * `fiber.await()`. A row that never leaves PENDING (a required service that
 * never appears) still holds the second one; no row here injects one.
 *
 * @param order - which applies first.
 * @returns the modules for {@link stubModuleLoader}, and the fallback hook.
 */
const orderedModules = (order: ApplyOrder): OrderedModules => {
  const { promise: released, resolve: release } =
    Promise.withResolvers<boolean>();
  const [first, second] =
    order === "plugin-first" ? [name, PI_AI_PACKAGE] : [PI_AI_PACKAGE, name];
  const firstModule = HOST_MODULES.get(first) as {
    apply: (ctx: unknown, config: unknown) => unknown;
  };
  const held = async (): Promise<unknown> => {
    await released;
    return HOST_MODULES.get(second);
  };
  const firstApply = (ctx: unknown, config: unknown): unknown => {
    try {
      return firstModule.apply(ctx, config);
    } finally {
      release(true);
    }
  };
  return {
    modules: new Map<string, unknown>([
      ...HOST_MODULES,
      [first, { ...firstModule, apply: firstApply }],
      [second, held()],
    ]),
    watch: (root) => {
      root.on("internal/status", (fiber: Fiber) => {
        // The registry keys a runtime by its plugin's `apply`, so this is the
        // first row's fiber and no other.
        if (
          fiber.runtime?.callback === firstApply &&
          SETTLED_STATES.has(fiber.state)
        ) {
          release(true);
        }
      });
    },
  };
};

/** The bundle rows, in the ids the real host's `dsh-base` patch names them. */
const BUNDLE_ROWS = [
  { id: "llm", name: "@deepseek-ai/dsh-llm" },
  { id: "llm-pi-ai", name: PI_AI_PACKAGE },
  { id: "config-editor", name: "@deepseek-ai/dsh-config-editor" },
  { id: "settings", name: "@deepseek-ai/dsh-settings" },
  { id: name, name },
];

/** What {@link bootTierB} takes. */
export interface TierBOptions {
  /** pi-ai's `providers` dict, written to the profile patch. */
  readonly providers?: Record<string, unknown>;
  /** Mount this plugin's row (default `true`); host-only contracts leave it out. */
  readonly plugin?: boolean;
  /** A profile row for this plugin's config; omitted, the shipped defaults apply. */
  readonly pluginConfig?: Record<string, unknown>;
  /** The profile patch as raw YAML text, replacing the generated one (for `!!js`). */
  readonly profilePatchYaml?: string;
  readonly credentials?: FakeCredentials;
  readonly launchEnvironment?: FakeLaunchEnvironment;
  /** Runs on the root after the fakes are provided and before any row mounts. */
  readonly prepare?: (root: Context) => void;
  /**
   * Which of pi-ai and the plugin applies first (default `"plugin-first"`, the
   * order measured on the published binary). Ignored without the plugin row.
   */
  readonly order?: ApplyOrder;
}

/** A booted tier B. */
export interface TierB {
  readonly ctx: Context;
  readonly home: string;
  readonly profile: ProfileContext;
  readonly llm: HostLlm;
  readonly piEntry: Entry;
  readonly piFiber: Fiber;
  /** The plugin's entry; `undefined` when the boot left the row out. */
  readonly pluginEntry: Entry | undefined;
  readonly credentials: FakeCredentials;
  readonly dispose: () => Promise<void>;
}

/** The keys the plugin reads from the environment directly. */
export const AMBIENT_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
] as const;

/**
 * Blank the keys the plugin reads directly (`src/fetch-patch.ts`,
 * `src/go-discovery.ts`) for the life of one boot, so a contributor's exported
 * key cannot turn the keyless rows into keyed ones. An empty value is what the
 * plugin reads as "no key". Only a key that IS set is touched, and the
 * returned restore puts back exactly what was there.
 *
 * @returns the restore, which the boot's dispose (and its failure path) runs.
 */
const blankAmbientKeys = (): (() => void) => {
  const saved = AMBIENT_KEYS.filter(
    (key) => (process.env[key] ?? "").length > 0
  ).map((key) => [key, process.env[key]] as const);
  for (const [key] of saved) {
    process.env[key] = "";
  }
  return () => {
    for (const [key, value] of saved) {
      process.env[key] = value;
    }
  };
};

/** The profile patch the S0-style boots write, as JSON text (valid YAML). */
const profilePatchText = (
  providers: Record<string, unknown> | undefined,
  pluginConfig: Record<string, unknown> | undefined
): string =>
  `${JSON.stringify(
    [
      ...(providers === undefined
        ? []
        : [{ config: { providers }, id: "llm-pi-ai" }]),
      ...(pluginConfig === undefined
        ? []
        : [{ config: pluginConfig, id: name }]),
    ],
    null,
    2
  )}\n`;

/**
 * Boot the host the way the harness's own composition tests do, with this
 * plugin's row mounted as the real host mounts it.
 *
 * @param options - the providers, the plugin row and the fakes.
 * @returns the booted host; the caller disposes it.
 */
export const bootTierB = async (options: TierBOptions = {}): Promise<TierB> => {
  const credentials = options.credentials ?? fakeCredentials();
  const launchEnvironment =
    options.launchEnvironment ?? fakeLaunchEnvironment();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dsh-opencode-host-")));
  const restoreKeys = blankAmbientKeys();
  let ctx: Context | undefined;
  try {
    const dir = join(home, "profiles", "test");
    initProfile(dir, ["test-bundle"]);
    const bundle = join(dir, "node_modules", "test-bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(home, "package.json"), '{"name":"test-installation"}\n');
    writeFileSync(
      join(bundle, "package.json"),
      JSON.stringify({
        dsh: { bundle: { patch: "cordis.patch.yml" } },
        name: "test-bundle",
        version: "1.0.0",
      })
    );
    writeFileSync(
      join(bundle, "cordis.patch.yml"),
      `${JSON.stringify(
        [
          {
            insert: BUNDLE_ROWS.filter(
              (row) => options.plugin !== false || row.id !== name
            ),
          },
        ],
        null,
        2
      )}\n`
    );
    writeFileSync(join(dir, "cordis.yml"), "[]\n");
    const patchPath = join(dir, "cordis.patch.yml");
    writeFileSync(
      patchPath,
      options.profilePatchYaml ??
        profilePatchText(options.providers, options.pluginConfig)
    );
    const profile: ProfileContext = {
      cwd: home,
      dir,
      home,
      installAnchor: join(home, "package.json"),
      name: "test",
      overlays: [],
      patchPath,
      startedBundles: ["test-bundle"],
      telemetryDisabledEnv: undefined,
    };
    ctx = await boot(
      "dsh",
      join(dir, "cordis.yml"),
      readProfilePatches("dsh", profile),
      (root) => {
        root.provide("profileContext", profile);
        root.provide("credentials", credentials.service);
        root.provide("launchEnvironment", launchEnvironment.snapshot);
        if (options.plugin === false) {
          root.loader.internal = stubModuleLoader(HOST_MODULES);
        } else {
          const ordered = orderedModules(options.order ?? "plugin-first");
          ordered.watch(root);
          root.loader.internal = stubModuleLoader(ordered.modules);
        }
        options.prepare?.(root);
      }
    );
    const booted = ctx;
    const entries = booted.configEditor.entries();
    const entryFor = (id: string): Entry => {
      const found = entries.find((entry) => entry.options.id === id);
      if (found?.fiber === undefined) {
        throw new Error(`host harness: no mounted entry ${id}`);
      }
      return found;
    };
    const piEntry = entryFor("llm-pi-ai");
    const pluginEntry = options.plugin === false ? undefined : entryFor(name);
    return {
      credentials,
      ctx: booted,
      dispose: async () => {
        try {
          await booted.fiber.dispose();
        } finally {
          rmSync(home, { force: true, recursive: true });
          restoreKeys();
        }
      },
      home,
      llm: booted.llm,
      piEntry,
      get piFiber() {
        return piEntry.fiber!;
      },
      pluginEntry,
      profile,
    };
  } catch (error) {
    try {
      await ctx?.fiber.dispose();
    } finally {
      rmSync(home, { force: true, recursive: true });
      restoreKeys();
    }
    throw error;
  }
};

/** Only the two plane keys stored: what a user who pasted them into Settings has. */
export const planeKeysOnly = (): FakeCredentials =>
  fakeCredentials({
    refs: { OPENCODE_API_KEY: "zen-test", OPENCODE_GO_API_KEY: "go-test" },
  });

/**
 * session-controller's `hasProviderApiKey` (`api/session-controller/src/catalog.ts:97-116`),
 * restated line for line from the real parts, because the package does not
 * export it (its `exports` map reaches `SessionController` and
 * `buildModelCatalog` only). `initializeDefaultModel` (`index.ts:320-331`)
 * calls it after a Sign-in and, when it answers false, replaces the user's
 * default model with the account's first one. It answers the FIRST
 * configurable provider whose profile, read from `settings.describe`'s VALUE
 * at the provider's `settingsPath`, names an `apiKeyEnv` the credentials
 * service reports as configured — so it is the reader F20 changes.
 *
 * @param tier - the booted host.
 * @returns that provider's id (`true` upstream), or `undefined` (`false`).
 */
export const providerWithApiKey = async (
  tier: TierB
): Promise<string | undefined> => {
  const describeRef = tier.credentials.service.describe as unknown as (
    ref: string
  ) => Promise<{ configured: boolean }>;
  const namespaces = tier.ctx.settings.describe({ redactSecrets: true });
  for (const provider of tier.llm.listConfigurableProviders()) {
    if (provider.provider === "deepseek-account") {
      continue;
    }
    let profile: unknown = namespaces.find(
      (namespace) => namespace.ns === provider.settingsNs
    )?.value;
    for (const key of provider.settingsPath) {
      profile =
        typeof profile === "object" && profile !== null
          ? Reflect.get(profile, key)
          : undefined;
    }
    if (typeof profile !== "object" || profile === null) {
      continue;
    }
    const ref: unknown = Reflect.get(profile, "apiKeyEnv");
    if (typeof ref === "string" && ref.length > 0) {
      const described = await describeRef(ref);
      if (described.configured) {
        return provider.provider;
      }
    }
  }
  return undefined;
};

/** What the Models page shows for one plane: whether it is configured, under which key. */
export interface ModelsPageRow {
  readonly configured: boolean;
  readonly apiKeyEnv: string | undefined;
}

/**
 * The Models page's join, restated (`client/ui-settings-models/src/client/store.ts`
 * `joinProviderDirectory` and `read`, `:45-77`, `:174-182`, `:250-269`): each
 * plane's directory entry, looked up in `settings.describe({ redactSecrets:
 * true })` at its `settingsPath`. The client package is not installed here,
 * so the join is rebuilt from the real parts tier B holds.
 *
 * @param tier - the booted host.
 * @returns per plane, whether the page reads it configured and its `apiKeyEnv`.
 */
export const modelsPageRows = (tier: TierB): Record<string, ModelsPageRow> => {
  const views = tier.ctx.settings.describe({ redactSecrets: true });
  const rows: Record<string, ModelsPageRow> = {};
  for (const entry of tier.llm.listConfigurableProviders()) {
    if (!(PLANES as readonly string[]).includes(entry.provider)) {
      continue;
    }
    const view = views.find((namespace) => namespace.ns === entry.settingsNs);
    let profile: unknown = view?.value;
    for (const key of entry.settingsPath) {
      profile =
        typeof profile === "object" && profile !== null
          ? Reflect.get(profile, key)
          : undefined;
    }
    const ref: unknown =
      typeof profile === "object" && profile !== null
        ? Reflect.get(profile, "apiKeyEnv")
        : undefined;
    rows[entry.provider] = {
      apiKeyEnv: typeof ref === "string" && ref.length > 0 ? ref : undefined,
      configured:
        view !== undefined &&
        (entry.settingsPath.length === 0 || profile !== undefined),
    };
  }
  return rows;
};
