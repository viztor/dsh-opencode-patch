import { supportedProtocols } from "@deepseek-ai/dsh-llm-pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { HOST_VERSIONS } from "./support/host-versions.ts";
import {
  GOOGLE_SDK,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  protocolFor,
  ROUTE_FOR_PLANE_PROTOCOL,
  SELF_MOUNTED_ROUTES,
  UNSERVED_PLANE_SDKS,
  UNSERVED_SDKS,
} from "./support/src.ts";

/**
 * The protocols this plugin mounts must be ones the harness's own pi-ai layer
 * can build, and every SDK the catalog names must map to one of them.
 *
 * Two claims, each against the real package rather than a stand-in:
 *
 * - The routes the WRAPPER mounts may only name a protocol in
 *   `dsh-llm-pi-ai`'s own `PROTOCOLS` table, which refuses anything else
 *   outright. That is how `mistral-conversations` once shipped: it is in
 *   `COMPAT_GATES`, which looks like a protocol registry and is not one.
 * - Every catalog row resolves, through `protocolFor` (which reads
 *   `GATEWAY_PROTOCOL_FOR_SDK`), to a protocol pi's exported `api/*` modules
 *   implement — independent of which models any of pi's own gateway providers
 *   happen to list. The plugin's own SDK table, `PROTOCOL_FOR_SDK`
 *   (`src/responses-routes.ts`), is checked against the same modules as a
 *   second step. In this file "the wrapper's table" means only
 *   `dsh-llm-pi-ai`'s `PROTOCOLS`.
 *
 * The pi and harness versions these run against are named once, in
 * `test/support/host-versions.ts`.
 */
describe("mount · the protocols the harness can build", () => {
  it("names only protocols dsh-llm-pi-ai supports, for the routes it mounts", () => {
    // The wrapper's mount may only name a protocol in its own table, so the
    // claim splits by mechanism: routes the wrapper mounts are claimed
    // against its table, and routes the plugin mounts itself are claimed
    // against pi directly, in the companion below.
    const supported = new Set(supportedProtocols());
    const named = [
      ...new Set(
        Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
          Object.entries(plane.routes)
            .filter(([, route]) => !SELF_MOUNTED_ROUTES.has(route))
            .map(([protocol]) => protocol)
        )
      ),
    ];
    expect(named.filter((protocol) => !supported.has(protocol))).toEqual([]);
  });

  it("serves every self-mounted route a protocol pi itself implements", () => {
    // The wrapper's table refuses to name these — that refusal is why the
    // bridge exists — so the claim to verify is the different one: pi ships
    // the implementation the bridge hands its adapter, with the two stream
    // entry points the provider delegates to.
    const api = googleGenerativeAIApi();
    expect(typeof api.stream).toBe("function");
    expect(typeof api.streamSimple).toBe("function");
    const selfMounted = Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap(
      (plane) =>
        Object.entries(plane.routes)
          .filter(([, route]) => SELF_MOUNTED_ROUTES.has(route))
          .map(([protocol]) => protocol)
    );
    expect(selfMounted).toEqual([
      "google-generative-ai",
      "google-generative-ai",
    ]);
  });
});

/**
 * What the harness's pi-ai layer can do for the gateway, measured against the
 * real package rather than assumed.
 *
 * This plugin exists because a provider row carries one `api`, so a gateway
 * whose models span several protocols needs something to route each model to
 * the protocol it is served on. pi-ai already ships that: its `opencode` and
 * `opencode-go` providers carry a per-model `api` and a map of implementations.
 * A route that names one of them without naming an `api` reuses it whole.
 *
 * So the question this answers is whether we can rely on that instead of
 * reimplementing it, and the answer is a list, not an opinion.
 */
describe("mount · what pi-ai's own gateway providers cover", () => {
  const providers = builtinProviders();

  it("ships a provider for each plane", () => {
    expect(providers.find((p) => p.id === "opencode")).toBeDefined();
    expect(providers.find((p) => p.id === "opencode-go")).toBeDefined();
  });

  it("routes the gateway's Gemini models on the Google protocol", () => {
    const zen = providers.find((p) => p.id === "opencode");
    const gemini = (zen?.getModels() ?? []).filter((model) =>
      model.id.includes("gemini")
    );
    expect(gemini.length).toBeGreaterThan(0);
    for (const model of gemini) {
      expect(model.api).toBe("google-generative-ai");
    }
  });

  it("carries more than one protocol per plane", () => {
    for (const id of ["opencode", "opencode-go"]) {
      const apis = new Set(
        (providers.find((p) => p.id === id)?.getModels() ?? []).map(
          (model) => model.api
        )
      );
      // The whole reason this plugin has a routing layer: one plane, many
      // protocols. A provider that spoke one protocol would need none of it.
      expect(apis.size).toBeGreaterThan(1);
    }
  });

  it(`characterization (F10): pi ${HOST_VERSIONS.pi}'s opencode-go provider has no google-generative-ai`, () => {
    // A characterization of the pinned pi (`HOST_VERSIONS.pi`), not a
    // requirement: its Go provider lists no model on the Google protocol,
    // while the gateway's Go catalog does carry one. That gap is what the
    // bridge serves today. pi 1.3.0 added a Go Google row
    // (`gemini-4-argon-contributor`), which is why the provider-based routing
    // check that used to stand below passed on the newer pi and not this one.
    const go = providers.find((p) => p.id === "opencode-go");
    const apis = [
      ...new Set((go?.getModels() ?? []).map((model) => model.api)),
    ].toSorted();
    expect(apis).toEqual([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]);
    expect(OPENCODE_GO_CATALOG.some((m) => m.provider_npm === GOOGLE_SDK)).toBe(
      true
    );
  });
});

/**
 * Every catalogued model, against the protocols pi's own `api/*` modules
 * implement.
 *
 * The per-model `api` in our catalog is the vendor's own SDK (`@ai-sdk/…`), and
 * `protocolFor` turns it into a wire protocol — `openai-completions` for a row
 * that names no SDK, the provider's own default. This walks the whole catalog
 * rather than a sample, because the failure this catches is one model in a
 * refreshed catalog naming an SDK nobody has a protocol for - and a picker that
 * offers it looks exactly like a picker that does not.
 *
 * The claim is against pi's exported implementations, resolved from pi itself
 * (`@earendil-works/pi-ai/api/<protocol>.lazy`), not a provider's model list
 * and not a table kept here. An earlier version asked each plane's pi provider
 * whether it carried a model on the same protocol, which made the answer a
 * fact about pi's catalog: pi 1.3.0 listed a Go Gemini model and so passed,
 * while the pinned pi 1.1.0 lists none (characterized above, F10) although the
 * bridge serves those models through the same `google-generative-ai` module.
 * Models whose SDK is a recorded decision (`UNSERVED_SDKS`) are skipped: that
 * is the plugin saying so, not a gap. Plane-level decisions in
 * `UNSERVED_PLANE_SDKS` likewise, so the rows here are the rows the picker
 * offers (`isServableModel`, src/models-discovery.ts) and `test/catalog.test.ts`
 * walks.
 */
describe("routing · every catalog SDK maps to a protocol pi's api/* modules implement", () => {
  /**
   * Whether pi ships `api/<protocol>.lazy` with one `*Api` factory whose
   * implementation has both stream entry points the adapter delegates to.
   */
  const implemented = async (protocol: string): Promise<boolean> => {
    let module: Record<string, unknown>;
    try {
      module = (await import(
        /* @vite-ignore */ `@earendil-works/pi-ai/api/${protocol}.lazy`
      )) as Record<string, unknown>;
    } catch {
      return false;
    }
    const factories = Object.entries(module)
      .filter(([name]) => name.endsWith("Api"))
      .map(([, value]) => value);
    const [factory] = factories;
    if (factories.length !== 1 || typeof factory !== "function") {
      return false;
    }
    const api = (factory as () => unknown)() as {
      stream?: unknown;
      streamSimple?: unknown;
    };
    return (
      typeof api.stream === "function" && typeof api.streamSimple === "function"
    );
  };

  /** Every catalog row the plugin offers, with the protocol it resolves to. */
  const served = () =>
    (
      [
        ["opencode", OPENCODE_ZEN_CATALOG],
        ["opencode-go", OPENCODE_GO_CATALOG],
      ] as const
    ).flatMap(([plane, catalog]) =>
      catalog
        .filter(
          (model) =>
            model.provider_npm === undefined ||
            // The `${plane} + ${sdk}` key is the one `isServableModel` reads
            // (the route ids `opencode` / `opencode-go`). The set is empty
            // today; an entry that withholds a protocol on every plane then
            // turns the "four protocols" constant below red, for review.
            !(
              UNSERVED_SDKS.has(model.provider_npm) ||
              UNSERVED_PLANE_SDKS.has(`${plane} + ${model.provider_npm}`)
            )
        )
        .map((model) => ({ model, plane, protocol: protocolFor(model) }))
    );

  it("names no SDK whose protocol pi does not implement", async () => {
    const rows = served();
    // A check that read no models would otherwise pass by finding nothing.
    expect(rows.length).toBeGreaterThan(0);
    const protocols = [
      ...new Set(
        [
          ...rows.map((row) => row.protocol),
          ...Object.values(PROTOCOL_FOR_SDK),
        ].filter((name) => name !== undefined)
      ),
    ];
    const verdicts = new Map(
      await Promise.all(
        protocols.map(async (name) => [name, await implemented(name)] as const)
      )
    );
    const unsupported = rows
      .filter(
        (row) =>
          row.protocol === undefined || verdicts.get(row.protocol) !== true
      )
      .map(
        (row) =>
          `${row.plane} ${row.model.id}: ${row.model.provider_npm ?? "(default)"} -> ${row.protocol ?? "no protocol"}`
      );
    expect(unsupported).toEqual([]);
    // The plugin's own SDK table (`PROTOCOL_FOR_SDK`, src/responses-routes.ts)
    // names nothing pi lacks either.
    expect(
      Object.values(PROTOCOL_FOR_SDK).filter(
        (protocol) => verdicts.get(protocol) !== true
      )
    ).toEqual([]);
  });

  it("reaches the four protocols the plugin serves (a constant, labelled as one)", () => {
    // The set the catalog resolves to today, including the SDK-less default.
    // A fifth protocol is a deliberate change, reviewed here; whether pi
    // implements it is the case above, which reads pi rather than this list.
    expect(
      [...new Set(served().map((row) => row.protocol))].toSorted((a, b) =>
        (a ?? "").localeCompare(b ?? "")
      )
    ).toEqual([
      "anthropic-messages",
      "google-generative-ai",
      "openai-completions",
      "openai-responses",
    ]);
  });

  it("answers false for a protocol pi does not ship", async () => {
    // The negative control: an unknown module is not read as implemented.
    expect(await implemented("no-such-protocol")).toBe(false);
  });
});
