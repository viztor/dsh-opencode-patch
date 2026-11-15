import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import semver from "semver";
import { describe, expect, it } from "vitest";

import { HOST_VERSIONS } from "./support/host-versions.ts";
import {
  GOOGLE_SDK,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  protocolForSdk,
  PROTOCOLS,
} from "./support/src.ts";

/*
 * The protocols the plane adapter serves are the four `PROTOCOLS` names, each
 * built from pi's own `api/<protocol>.lazy` module (`buildPlaneProvider`), and
 * every SDK the catalog names maps to one of them. Both claims are made
 * against pi's exported implementations below, not a table kept here.
 *
 * The pi and harness versions these run against are named once, in
 * `test/support/host-versions.ts`.
 */

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

  /**
   * F10, per pi line: whether pi's own `opencode-go` provider lists a model on
   * the Google protocol. A characterization of the install under test, keyed
   * by the pi it runs (`HOST_VERSIONS.pi`: the channel's newest, or its
   * floor), not a requirement. pi 1.1.0, the floor of the `0.2.1` rc
   * builds, has none; pi 1.3.0, both channels' floor since, added a Go
   * Google row, and 1.5 keeps it. The gateway's Go catalog carries Google models either way,
   * which the plugin routes through its own adapter, so the row describes pi,
   * not the plugin.
   *
   * Rows are pi LINES, not exact versions, so a channel bump that moves pi
   * inside a line stays version data (CONTRIBUTING's release step 3): the case
   * fails only for a pi outside every row, which is a new major and a
   * reviewed change, or for a pi whose provider contradicts its row, which is
   * the measured change this row exists to catch.
   */
  const GO_HAS_GOOGLE: readonly (readonly [line: string, google: boolean])[] = [
    [">=1.1.0 <1.3.0", false],
    [">=1.3.0 <2.0.0", true],
  ];

  const f10RowFor = (pi: string): boolean[] =>
    GO_HAS_GOOGLE.filter(([line]) => semver.satisfies(pi, line)).map(
      ([, google]) => google
    );

  it("F10's rows are one answer per pi line, with known answers", () => {
    expect(f10RowFor("1.1.0")).toEqual([false]);
    expect(f10RowFor("1.2.9")).toEqual([false]);
    expect(f10RowFor("1.3.0")).toEqual([true]);
    expect(f10RowFor("1.5.0")).toEqual([true]);
    expect(f10RowFor("1.6.2")).toEqual([true]);
    // Outside every line: a new major, or a pi below every channel's floor.
    expect(f10RowFor("2.0.0")).toEqual([]);
    expect(f10RowFor("1.0.9")).toEqual([]);
  });

  it(`characterization (F10): pi ${HOST_VERSIONS.pi}'s opencode-go provider and the Google protocol`, () => {
    const rows = f10RowFor(HOST_VERSIONS.pi);
    expect(
      rows,
      `no F10 row for pi ${HOST_VERSIONS.pi}'s line: measure it and add one`
    ).toHaveLength(1);
    const [expected] = rows;
    const go = providers.find((p) => p.id === "opencode-go");
    const apis = new Set((go?.getModels() ?? []).map((model) => model.api));
    expect(apis.has("google-generative-ai")).toBe(expected);
    for (const api of [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]) {
      expect(apis.has(api), api).toBe(true);
    }
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
 * `protocolForSdk` turns it into a wire protocol — `openai-completions` for a row
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
 * while pi 1.1.0 (the floor of the `0.2.1` rc builds) lists none
 * (characterized above, F10) although the plane adapter serves those models
 * through the same `google-generative-ai` module. No SDK is withheld any more
 * (D16), so every catalog row is walked.
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
      catalog.map((model) => ({
        model,
        plane,
        protocol: protocolForSdk(model.provider_npm),
      }))
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
          ...PROTOCOLS,
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
    // The plugin's own SDK table (`PROTOCOL_FOR_SDK`, src/utils/protocols.ts)
    // and the protocols the plane provider is built from name nothing pi
    // lacks either.
    expect(
      [...Object.values(PROTOCOL_FOR_SDK), ...PROTOCOLS].filter(
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
    // And it is the set the plane provider is built from, no more.
    expect([...PROTOCOLS].toSorted()).toEqual([
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
