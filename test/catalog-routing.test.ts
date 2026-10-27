/**
 * OpenCode Model Catalog: every model is routable, on its own plane's base.
 *
 * @module test/catalog-routing.test
 */
import { describe, expect, it } from "vitest";

import { catalogRow, findCatalogRow } from "./support/catalog-fixture.ts";
import {
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  PROTOCOL_FOR_SDK,
  protocolForSdk,
  isServableSdk,
  planeModelFor,
} from "./support/src.ts";

/**
 * Every SDK the generated catalog names must be CLASSIFIED - either mapped to a
 * protocol or listed as deliberately unserved. The failure this prevents is
 * silent: models.dev gains a new SDK, the freshness gate regenerates the shim
 * and passes, and the model disappears from the picker because the servability
 * check treats "unknown" as "unservable".
 */

describe("catalog · SDK coverage", () => {
  it("classifies every provider SDK the catalog names", () => {
    const named = new Set<string>();
    for (const plane of [OPENCODE_ZEN_CATALOG, OPENCODE_GO_CATALOG]) {
      for (const model of Object.values(plane)) {
        const sdk = (model as { provider_npm?: string }).provider_npm;
        if (typeof sdk === "string" && sdk.length > 0) {
          named.add(sdk);
        }
      }
    }
    // Non-vacuous: the catalogs name more than one SDK.
    expect(named.size).toBeGreaterThan(1);
    const classified = new Set(Object.keys(PROTOCOL_FOR_SDK));
    expect([...named].filter((sdk) => !classified.has(sdk))).toEqual([]);
    expect([...named].filter((sdk) => !isServableSdk(sdk))).toEqual([]);
  });
});

/** A plane's model as the plane adapter would build it, on the default family. */
const servedOn = (
  route: "opencode" | "opencode-go",
  id: string,
  routeApi?: string
) => {
  const catalog =
    route === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;
  const spec = catalog.find((candidate) => candidate.id === id);
  const result = planeModelFor({
    defaults: { contextWindow: 262_144, input: ["text"], maxTokens: 32_768 },
    endpoint: "modern",
    entry: { id },
    familyApi:
      route === "opencode" ? OPENCODE_FAMILY_API.zen : OPENCODE_FAMILY_API.go,
    route,
    ...(routeApi === undefined ? {} : { routeApi }),
    ...(spec === undefined ? {} : { spec }),
  });
  if (result.model === undefined) {
    throw new Error(`${route}/${id}: ${result.error}`);
  }
  return result.model;
};

/**
 * INVARIANT I1 - every model the plugin offers is routable.
 *
 * The picker shows both planes' models. A model naming an SDK is served on that
 * SDK's protocol, on ITS OWN plane: the Go plane's base URL is not Zen's. One
 * route per plane carries every protocol (D13), so the check is that each
 * catalog model resolves to a protocol and to a base on its own plane.
 */
describe("catalog · plane and SDK coverage", () => {
  it("serves every catalog model on its own plane's base, whatever its SDK", () => {
    const gaps: string[] = [];
    const planes = [
      ["opencode", OPENCODE_ZEN_CATALOG],
      ["opencode-go", OPENCODE_GO_CATALOG],
    ] as const;
    let checked = 0;
    for (const [plane, catalog] of planes) {
      for (const spec of catalog) {
        const model = servedOn(plane, spec.id);
        checked += 1;
        const onGo = new URL(model.baseUrl).pathname.startsWith(
          "/inference/go/"
        );
        if (model.api !== protocolForSdk(spec.provider_npm)) {
          gaps.push(`${plane}/${spec.id}: ${model.api}`);
        }
        if (onGo !== (plane === "opencode-go")) {
          gaps.push(`${plane}/${spec.id}: ${model.baseUrl}`);
        }
      }
    }
    expect(checked).toBe(
      OPENCODE_ZEN_CATALOG.length + OPENCODE_GO_CATALOG.length
    );
    expect(gaps).toEqual([]);
  });
});

/**
 * The base each (plane, protocol) is served on, on the default family. The
 * rows are picked by shape (`findCatalogRow`), never by a vendor id a refresh
 * can retire; only the bases are pinned, and a cell whose plane no longer
 * carries a row on that protocol is skipped rather than failed.
 */
const PINNED_BASES = [
  ["opencode", "openai-responses", "https://opencode.ai/inference/openai/v1"],
  [
    "opencode-go",
    "openai-responses",
    "https://opencode.ai/inference/go/openai/v1",
  ],
  [
    "opencode-go",
    "anthropic-messages",
    "https://opencode.ai/inference/go/anthropic",
  ],
  [
    "opencode-go",
    "google-generative-ai",
    "https://opencode.ai/inference/go/google/v1beta",
  ],
] as const;

/**
 * The plane is half of the routing decision. An SDK says which shape a model
 * needs; only the route the caller selected says which account and base URL
 * serve it.
 */
describe("routing · the plane half of the decision", () => {
  it("sends the same SDK to a different base per plane", () => {
    // A pinned base is a property of the routing table, not of the vendor
    // catalog: a refresh that retires a plane's last row on one protocol
    // skips that cell rather than failing it. `plane-model.test.ts` pins
    // every (plane, protocol) base catalog-free through `baseUrlFor`.
    let checked = 0;
    for (const [route, api, baseUrl] of PINNED_BASES) {
      const row = findCatalogRow(route, api);
      if (row === undefined) {
        continue;
      }
      expect(servedOn(route, row.id), `${route}/${row.id}`).toMatchObject({
        api,
        baseUrl,
      });
      checked += 1;
    }
    expect(checked, "no pinned cell has a catalogued row").toBeGreaterThan(0);
  });
});

/**
 * The default format. A model that speaks completions has no SDK of its own,
 * and an id nobody catalogued is served the same way (D15): a name is not a
 * protocol, so `claude-unlisted-9` is not guessed onto Messages.
 */
describe("routing · the default format", () => {
  it("serves a model with no SDK of its own as completions", () => {
    let checked = 0;
    for (const route of ["opencode", "opencode-go"] as const) {
      // A plane whose shim names an SDK for every row has nothing to check.
      const row = findCatalogRow(route);
      if (row !== undefined) {
        expect(servedOn(route, row.id).api, `${route}/${row.id}`).toBe(
          "openai-completions"
        );
        checked += 1;
      }
    }
    expect(checked, "no plane carries a row without an SDK").toBeGreaterThan(0);
  });

  it("serves an id the catalog does not describe as completions, unless the route names a protocol", () => {
    expect(servedOn("opencode", "claude-unlisted-9").api).toBe(
      "openai-completions"
    );
    expect(servedOn("opencode", "gemini-unlisted-9").api).toBe(
      "openai-completions"
    );
    expect(
      servedOn("opencode", "claude-unlisted-9", "anthropic-messages").api
    ).toBe("anthropic-messages");
    // A route-level api never reclassifies an id the catalog describes.
    const responses = catalogRow("opencode", "openai-responses").id;
    expect(servedOn("opencode", responses, "anthropic-messages").api).toBe(
      "openai-responses"
    );
  });
});
