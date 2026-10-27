/**
 * Settings' model discovery on the real host (P3, D3, D8, D15, D21).
 *
 * The P3 rows of the plan's test matrix: what Settings → Models → Fetch
 * answers on each plane, while pi-ai restarts, for a plane with no `models`
 * list, and for a gap id adopted from it and saved; and the contract that the
 * wrapper is what the gateway's own dispatch reaches, before and after a
 * pi-ai restart and an `llm` restart. The fetch, restart, no-models-list,
 * gap-save and contract cases each boot their own tier B and read the host's
 * answers, the profile file and the wire — never the plugin's own state. The
 * stood-down case mounts tier A with `hostModules: null`, which keeps the
 * plugin's default host-module source: it cannot find pi-ai's module, so the
 * route claim stands down, pi-ai keeps the planes, and the wrapper is shown
 * reading that real claim.
 *
 * Every tier B case boots the published binary's apply order
 * (`plugin-first`); the pi-ai restart that a `pi-ai-first` mount causes is the
 * same withdrawal the restart case drives directly. The tier A stood-down case
 * mounts pi-ai first, as tier A always does; with the claim stood down no
 * restart follows (the claim restarts only a pi-ai lacking a declared plane,
 * and there pi-ai resolved holding both), so the order is immaterial.
 *
 * The gateway (`@deepseek-ai/dsh-api-gateway`) is not installed here, so its
 * dispatch is restated from dsh-llm's own typert descriptor: the service and
 * the implementation it names, read from a fresh view of the context the way
 * the gateway resolves a method per call, and the result codec the Remote
 * encodes the answer with.
 *
 * @module test/host-discovery.test
 */
import { readFileSync } from "node:fs";

import type { Context } from "@deepseek-ai/cordis";
import { TYPERT } from "@deepseek-ai/dsh-llm/typert";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootTierB,
  CHARACTERIZED_MODELS,
  characterizedProviders,
  drainStream,
  fakeCredentials,
  type HostLlm,
  mountTierA,
  ownerOf,
  type Plane,
  PLANES,
  piKnows,
  recordingFetch,
  type RecordingFetch,
  s0Providers,
  type TierA,
  type TierB,
  waitForPlaneOwner,
} from "./support/host.ts";
import {
  inspectPatch,
  isDeprecatedModelOn,
  isRecord,
  isServableSdk,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  sanitizeModalities,
} from "./support/src.ts";

let tier: TierB | undefined;
let tierA: TierA | undefined;
let wire: RecordingFetch;

afterEach(async () => {
  try {
    await tier?.dispose();
    await tierA?.dispose();
  } finally {
    tier = undefined;
    tierA = undefined;
    vi.unstubAllGlobals();
  }
});

/** One discovered row, in the Remote's shape. */
interface Row {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputModalities?: string[];
}

/** One typert invocation descriptor, as far as the gateway reads it. */
interface Invocation {
  readonly id: string;
  readonly service: string;
  readonly implementation: string;
  readonly result: {
    readonly create: () => { parse: (value: unknown) => unknown };
  };
}

/** dsh-llm's descriptor for `llm/discoverModels`, the one the Models page calls. */
const DISCOVER = (
  TYPERT as { readonly invocations: readonly Invocation[] }
).invocations.find(
  (invocation) => invocation.id === "@deepseek-ai/dsh-llm#llm/discoverModels"
);

const descriptor = (): Invocation => {
  if (DISCOVER === undefined) {
    throw new Error("dsh-llm's typert names no llm/discoverModels");
  }
  return DISCOVER;
};

/** pi's own ids for a plane, once each, in pi's order. */
const piIds = (plane: Plane): string[] => [
  ...new Set(
    getBuiltinModels(plane as never).map((model: { id: string }) => model.id)
  ),
];

/** The plane's servable catalog ids, in catalog order. */
const servable = (plane: Plane): string[] =>
  (plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG)
    .filter((spec) => isServableSdk(spec.provider_npm))
    .map((spec) => spec.id);

/**
 * pi's ids the wrapper keeps on a plane: it drops an id the live catalog has
 * retired, on every path. Offline nothing is retired (the shim ships active
 * models and the catalog refresh is refused), so this filter keeps them all;
 * it states the wrapper's rule, not a difference this suite can observe.
 */
const piKept = (plane: Plane): string[] =>
  piIds(plane).filter(
    (id) => !isDeprecatedModelOn(plane === "opencode" ? "zen" : "go", id)
  );

/** What Settings' fetch on a served plane answers: pi's ids, then the catalog's others. */
const expected = (plane: Plane): string[] => {
  const pi = piKept(plane);
  return [...pi, ...servable(plane).filter((id) => !pi.includes(id))];
};

/** The settings namespace a plane is configured under, as the Models page reads it. */
const nsOf = (llm: HostLlm, plane: Plane): string | undefined =>
  llm.listConfigurableProviders().find((entry) => entry.provider === plane)
    ?.settingsNs;

const idsOf = (rows: readonly { readonly id: string }[]): string[] =>
  rows.map((row) => row.id);

/**
 * The gateway's dispatch of `llm/discoverModels`, restated: the descriptor's
 * service read from a fresh view of the context, and its implementation read
 * from that view per call — which is how an instance wrapper is reached.
 */
const viaGateway = async (
  ctx: Context,
  ns: string,
  request: Record<string, unknown>
): Promise<{
  answer: Row[];
  schema: { parse: (value: unknown) => unknown };
}> => {
  const invocation = descriptor();
  const view: unknown = ctx.extend({}).get(invocation.service as never);
  if (typeof view !== "object" || view === null) {
    throw new Error(`no ${invocation.service} service on the view`);
  }
  const method: unknown = Reflect.get(view, invocation.implementation);
  if (typeof method !== "function") {
    throw new TypeError(`no ${invocation.implementation} on the service`);
  }
  const answer = (await Reflect.apply(method, view, [
    ns,
    request,
    new AbortController().signal,
  ])) as Row[];
  return { answer, schema: invocation.result.create() };
};

/** Poll until `predicate` holds, or fail by name. */
const until = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 10_000
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() > end) {
      throw new Error(`never happened: ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** Boot tier B offline with a fresh wire recorder (stubbed before the boot). */
const boot = async (
  providers: Record<string, unknown>,
  credentials = fakeCredentials({
    refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
  })
): Promise<TierB> => {
  wire = recordingFetch();
  vi.stubGlobal("fetch", wire.fetch);
  tier = await bootTierB({ credentials, providers });
  return tier;
};

/** cordis `FiberState.UNLOADING`. */
const UNLOADING = 5;

describe(
  "host discovery · Settings' fetch (tier B)",
  { timeout: 30_000 },
  () => {
    it("on each plane answers pi's own list, then every servable catalog model pi does not list, each id once, in the Remote's own result shape (D3)", async () => {
      const { llm } = await boot(characterizedProviders());
      await waitForPlaneOwner(llm);
      const schema = descriptor().result.create();
      const answers: Partial<Record<Plane, Row[]>> = {};
      for (const plane of PLANES) {
        const ns = nsOf(llm, plane);
        expect(ns, plane).toBe("llm-pi-ai");
        const rows = (await llm.discoverModels(ns ?? "", {
          provider: plane,
        })) as Row[];
        expect(idsOf(rows), plane).toEqual(expected(plane));
        // Non-vacuous: the catalog has models pi does not list on this plane.
        expect(
          servable(plane).filter((id) => piKnows(plane, id) === undefined)
            .length,
          plane
        ).toBeGreaterThan(0);
        // The Remote's codec keeps every row as it is: no unknown key, and
        // modalities are text/image only.
        expect(schema.parse(rows), plane).toStrictEqual(rows);
        // Every row the catalog describes carries the CATALOG's values, pi's
        // rows included: the composer serves a plane model catalog-first
        // (D17), and a row adopted from the fetch is saved as the user's row,
        // which the composer reads before the catalog.
        const catalog =
          plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;
        for (const row of rows) {
          const spec = catalog.find((model) => model.id === row.id);
          if (spec === undefined) {
            continue;
          }
          expect(row, `${plane}/${row.id}`).toStrictEqual({
            contextWindow: spec.context_window,
            id: row.id,
            inputModalities: sanitizeModalities(spec.input_modalities),
            maxTokens: spec.max_output_tokens,
            name: spec.name,
          });
        }
        answers[plane] = rows;
      }
      // Non-vacuous: pi knows a Zen model at a capacity the catalog does not
      // (measured on pi 1.1.0: claude-sonnet-4-5 at 200000, catalog 1000000).
      const differing = (
        getBuiltinModels("opencode" as never) as {
          contextWindow?: number;
          id: string;
        }[]
      ).filter((model) => {
        const spec = OPENCODE_ZEN_CATALOG.find((each) => each.id === model.id);
        return (
          spec !== undefined && model.contextWindow !== spec.context_window
        );
      });
      expect(differing.length).toBeGreaterThan(0);
      const zen = idsOf(answers.opencode ?? []);
      const go = idsOf(answers["opencode-go"] ?? []);
      expect(zen).toContain("gpt-5.3-codex-spark");
      expect(go).toContain("minimax-m3.1-flash");
      expect(go).toContain("gemini-4-argon");
      // A gap row is the CATALOG's row — never the user's saved
      // `My Spark`/400000, which is configuration, not discovery.
      const spec = OPENCODE_ZEN_CATALOG.find(
        (model) => model.id === "gpt-5.3-codex-spark"
      );
      expect(
        answers.opencode?.find((row) => row.id === "gpt-5.3-codex-spark")
      ).toStrictEqual({
        contextWindow: spec?.context_window,
        id: "gpt-5.3-codex-spark",
        inputModalities: sanitizeModalities(spec?.input_modalities),
        maxTokens: spec?.max_output_tokens,
        name: spec?.name,
      });
    });

    it("F21 — while pi-ai restarts answers the plane's catalog instead of NO_DISCOVERY, directly and through the gateway, and the full answer is back once it settles", async () => {
      const current = await boot(characterizedProviders());
      await waitForPlaneOwner(current.llm);
      const request = { provider: "opencode" };
      type Settled = { ok: unknown } | { error: unknown };
      const settled = (promise: Promise<unknown>): Promise<Settled> =>
        promise.then(
          (ok) => ({ ok }),
          (error: unknown) => ({ error })
        );
      let calls:
        | {
            control: Promise<Settled>;
            direct: Promise<Row[]>;
            gateway: Promise<{ answer: Row[] }>;
          }
        | undefined;
      const prototypeDiscover = (
        Reflect.getPrototypeOf(current.llm) as {
          discoverModels: (...args: unknown[]) => Promise<unknown>;
        }
      ).discoverModels;
      const off = current.ctx.on("internal/status", (fiber, old) => {
        // pi-ai's discovery is withdrawn between UNLOADING and the reload: the
        // window is read synchronously, on the transition OUT of UNLOADING.
        if (
          fiber !== current.piFiber ||
          old !== UNLOADING ||
          calls !== undefined
        ) {
          return;
        }
        calls = {
          control: settled(
            Reflect.apply(prototypeDiscover, current.llm, [
              "llm-pi-ai",
              request,
            ]) as Promise<unknown>
          ),
          direct: current.llm.discoverModels(
            "llm-pi-ai",
            request
          ) as unknown as Promise<Row[]>,
          gateway: viaGateway(current.ctx, "llm-pi-ai", request),
        };
      });
      try {
        await current.piFiber.restart();
      } finally {
        off();
      }
      expect(calls, "the restart passed through UNLOADING").toBeDefined();
      // The host's own method, unwrapped, answers NO_DISCOVERY in this window:
      // the window was hit.
      const control = await calls?.control;
      expect(control).toMatchObject({ error: { code: "NO_DISCOVERY" } });
      const direct = (await calls?.direct) ?? [];
      expect(idsOf(direct)).toEqual(servable("opencode"));
      const gateway = await calls?.gateway;
      expect(idsOf(gateway?.answer ?? [])).toEqual(servable("opencode"));
      await waitForPlaneOwner(current.llm);
      expect(
        idsOf((await current.llm.discoverModels("llm-pi-ai", request)) as Row[])
      ).toEqual(expected("opencode"));
    });

    it("a plane with no models list: the composer lists the plane's servable catalog keyless, Settings' fetch offers every id the composer lists, and the profile file is never written (D3, D8, D21)", async () => {
      const current = await boot(
        {
          deepseek: s0Providers().deepseek,
          opencode: { apiKeyEnv: "OPENCODE_API_KEY" },
        },
        fakeCredentials()
      );
      await waitForPlaneOwner(current.llm, ["opencode"]);
      const before = readFileSync(current.profile.patchPath);
      const composer = idsOf(await current.llm.listModels("opencode"));
      expect(composer).toEqual(servable("opencode"));
      const fetched = idsOf(
        (await current.llm.discoverModels(nsOf(current.llm, "opencode") ?? "", {
          provider: "opencode",
        })) as Row[]
      );
      expect(fetched).toEqual(expect.arrayContaining(composer));
      expect(fetched).toEqual(expected("opencode"));
      expect(readFileSync(current.profile.patchPath)).toEqual(before);
    });

    it("a gap row adopted from Settings' fetch saves like any other, and the composer lists, validates and sends it on the plugin's adapter (D15)", async () => {
      const current = await boot(characterizedProviders());
      await waitForPlaneOwner(current.llm);
      const rows = (await current.llm.discoverModels("llm-pi-ai", {
        provider: "opencode",
      })) as Row[];
      const gap = rows.find(
        (row) =>
          piKnows("opencode", row.id) === undefined &&
          !CHARACTERIZED_MODELS.opencode.includes(row.id)
      );
      expect(gap, "the fetch offers a model pi does not list").toBeDefined();
      if (gap === undefined) {
        return;
      }
      // ModelListEditor's `adopt()`, restated: the row as the editor drafts it.
      const adopted = {
        id: gap.id,
        ...(gap.name === undefined ? {} : { name: gap.name }),
        ...(gap.contextWindow === undefined
          ? {}
          : { contextWindow: gap.contextWindow }),
        ...(gap.maxTokens === undefined ? {} : { maxTokens: gap.maxTokens }),
        ...(gap.inputModalities === undefined
          ? {}
          : { input: [...gap.inputModalities] }),
      };
      // Before the save the composer does not list it: what lists it below is
      // the save, not a composer widened to the catalog (D3, D8).
      expect(idsOf(await current.llm.listModels("opencode"))).not.toContain(
        gap.id
      );
      expect(readFileSync(current.profile.patchPath, "utf8")).not.toContain(
        gap.id
      );
      await current.ctx.configEditor.edit(current.piEntry, (raw) => {
        const providers = {
          ...(raw.providers as Record<string, Record<string, unknown>>),
        };
        const entry = providers.opencode ?? {};
        providers.opencode = {
          ...entry,
          models: [...((entry.models as unknown[]) ?? []), adopted],
        };
        return { ...raw, providers };
      });
      expect(readFileSync(current.profile.patchPath, "utf8")).toContain(gap.id);
      await until(
        async () =>
          idsOf(await current.llm.listModels("opencode")).includes(gap.id),
        "the adopted id is listed"
      );
      await expect(
        current.llm.resolveCallConfig({
          model: gap.id,
          provider: "opencode",
        } as never)
      ).resolves.toBeDefined();
      expect(ownerOf(current.llm, "opencode")).toBe("PlaneAdapter");
      const sentBefore = wire.requests.length;
      const drained = await drainStream(current.llm, "opencode", gap.id);
      const sent = wire.requests
        .slice(sentBefore)
        .filter(
          (request) => !request.url.startsWith("https://models.opencode.ai/")
        );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.model).toBe(gap.id);
      expect(sent[0]?.url.startsWith("https://opencode.ai/inference/")).toBe(
        true
      );
      expect(drained.finish?.code).toBe("AUTH");
    });
  }
);

describe("host discovery · contract (tier B)", { timeout: 30_000 }, () => {
  it("F21 — the wrapper is seen through the gateway's own dispatch and survives a pi-ai restart and an llm restart", async () => {
    const current = await boot(characterizedProviders());
    await waitForPlaneOwner(current.llm);
    // The descriptor names what the gateway calls: if a host renames it, this
    // fails here before the binary probe, which calls it by name.
    expect(descriptor().implementation).toBe("remoteDiscoverModels");
    expect(descriptor().service).toBe("llm");
    const request = { provider: "opencode" };
    const first = await viaGateway(current.ctx, "llm-pi-ai", request);
    expect(idsOf(first.answer)).toEqual(expected("opencode"));
    expect(first.schema.parse(first.answer)).toStrictEqual(first.answer);

    const site = (llm: HostLlm) =>
      inspectPatch(
        Reflect.getOwnPropertyDescriptor(llm, "discoverModels")?.value,
        "discoverModels"
      );
    const live = [
      {
        holdsWrapper: true,
        id: "dsh-opencode-patch/model-discovery",
        live: true,
      },
    ];

    await current.piFiber.restart();
    await waitForPlaneOwner(current.llm);
    expect(site(current.llm)).toEqual(live);
    const afterPiAi = await viaGateway(current.ctx, "llm-pi-ai", request);
    expect(idsOf(afterPiAi.answer)).toEqual(expected("opencode"));

    const llmEntry = current.ctx.configEditor
      .entries()
      .find((entry) => entry.options.id === "llm");
    expect(llmEntry?.fiber).toBeDefined();
    await llmEntry?.fiber?.restart();
    await waitForPlaneOwner(current.ctx.llm);
    expect(site(current.ctx.llm)).toEqual(live);
    // Wait on pi-ai's own discovery, not on the wrapper: during NO_DISCOVERY
    // the wrapper answers the catalog alone, which is non-empty, so a wait on
    // the gateway's answer could stop before pi-ai re-registers. The host's
    // unwrapped method rejects NO_DISCOVERY until it has.
    const unwrapped = (
      Reflect.getPrototypeOf(current.ctx.llm) as {
        discoverModels: (...args: unknown[]) => Promise<unknown>;
      }
    ).discoverModels;
    await until(async () => {
      try {
        await Reflect.apply(unwrapped, current.ctx.llm, ["llm-pi-ai", request]);
      } catch (error) {
        if (isRecord(error) && error.code === "NO_DISCOVERY") {
          return false;
        }
        throw error;
      }
      return true;
    }, "pi-ai's discovery is registered on the new llm");
    const viaNewLlm = await viaGateway(current.ctx, "llm-pi-ai", request);
    expect(idsOf(viaNewLlm.answer)).toEqual(expected("opencode"));
  });
});

describe(
  "host discovery · a stood-down claim (tier A)",
  { timeout: 30_000 },
  () => {
    it("with the claim stood down, Settings' fetch on a plane answers pi's own list, and no catalog model pi lacks (the real claim reaches the wrapper)", async () => {
      wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      // No loader and the plugin's default host-module source: it cannot find
      // pi-ai's module, so the route claim stands down and pi-ai keeps the
      // planes. The wrapper is still installed; it must read THIS claim.
      tierA = await mountTierA({
        credentials: fakeCredentials({
          refs: { OPENCODE_API_KEY: "zen-k", OPENCODE_GO_API_KEY: "go-k" },
        }),
        hostModules: null,
        plugin: {},
        providers: characterizedProviders(),
      });
      const { llm } = tierA;
      await waitForPlaneOwner(llm, PLANES, "PiAiAdapter");
      expect(
        inspectPatch(
          Reflect.getOwnPropertyDescriptor(llm, "discoverModels")?.value,
          "discoverModels"
        )
      ).toEqual([
        {
          holdsWrapper: true,
          id: "dsh-opencode-patch/model-discovery",
          live: true,
        },
      ]);
      for (const plane of PLANES) {
        const pi = piKept(plane);
        const rows = (await llm.discoverModels("llm-pi-ai", {
          provider: plane,
        })) as Row[];
        expect(idsOf(rows), plane).toEqual(pi);
        // Non-vacuous: a live claim would have offered these.
        const gap = servable(plane).filter((id) => !pi.includes(id));
        expect(gap.length, plane).toBeGreaterThan(0);
        expect(
          idsOf(rows).filter((id) => gap.includes(id)),
          plane
        ).toEqual([]);
      }
    });
  }
);
