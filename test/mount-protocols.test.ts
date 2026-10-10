import { supportedProtocols } from "@deepseek-ai/dsh-llm-pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  ROUTE_FOR_PLANE_PROTOCOL,
  UNSERVED_SDKS,
} from "../src/index.ts";

/**
 * The protocols this plugin mounts must be ones the harness's own pi-ai layer
 * can build.
 *
 * `dsh-llm-pi-ai` constructs a hand-declared route from `PROTOCOLS`, and that
 * table has three entries. A route naming anything else is refused outright, so
 * the plugin's whole routing layer is bounded by this list - and nothing checked
 * it: the unit suite mounts against a stand-in that accepts any `api`, and the
 * e2e suite talks to the gateway without going through the mount at all.
 *
 * That is how `mistral-conversations` shipped. It is in `COMPAT_GATES`, which
 * looks like a protocol registry and is not one, and the real table refuses it.
 *
 * `it.fails` while that route is still declared: it passes only while the gap is
 * real, and turns red the moment the mapping is corrected, which is the signal
 * to make it a plain assertion.
 */
describe("mount · the protocols the harness can build", () => {
  it("names only protocols dsh-llm-pi-ai supports", () => {
    const supported = new Set(supportedProtocols());
    const named = [
      ...new Set([
        ...Object.values(PROTOCOL_FOR_SDK),
        ...Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
          Object.keys(plane.routes)
        ),
      ]),
    ];
    expect(named.filter((protocol) => !supported.has(protocol))).toEqual([]);
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
});

/**
 * Every catalogued model, against the protocols its plane's provider implements.
 *
 * The per-model `api` in our catalog is the vendor's own SDK (`@ai-sdk/…`), and
 * `PROTOCOL_FOR_SDK` turns it into a wire protocol. This walks the whole catalog
 * rather than a sample, because the failure this catches is one model in a
 * refreshed catalog naming an SDK nobody has a protocol for - and a picker that
 * offers it looks exactly like a picker that does not.
 *
 * A model is fine when its plane's pi-ai provider has at least one model on the
 * same protocol, since a provider only carries protocols it can speak. Models
 * whose SDK is a recorded decision (`UNSERVED_SDKS`) are skipped: that is the
 * plugin saying so, not a gap.
 */
describe("routing · every catalogued model has a protocol its plane can serve", () => {
  const protocolsOf = (id: string): Set<string> =>
    new Set(
      (
        builtinProviders()
          .find((p) => p.id === id)
          ?.getModels() ?? []
      ).map((model) => model.api)
    );

  const planes = [
    { catalog: OPENCODE_ZEN_CATALOG, id: "opencode" },
    { catalog: OPENCODE_GO_CATALOG, id: "opencode-go" },
  ];

  it("names no protocol its plane's provider cannot speak", () => {
    const unsupported: string[] = [];
    let checked = 0;
    for (const { catalog, id } of planes) {
      const protocols = protocolsOf(id);
      for (const model of catalog) {
        const sdk = model.provider_npm;
        // No SDK means the provider's own default, which is always servable.
        if (sdk === undefined || UNSERVED_SDKS.has(sdk)) {
          continue;
        }
        checked += 1;
        const protocol = PROTOCOL_FOR_SDK[sdk];
        if (protocol === undefined || !protocols.has(protocol)) {
          unsupported.push(
            `${id} ${model.id}: ${sdk} -> ${protocol ?? "no protocol"}`
          );
        }
      }
    }
    // A check that read no models would otherwise pass by finding nothing.
    expect(checked).toBeGreaterThan(0);
    expect(unsupported).toEqual([]);
  });
});
