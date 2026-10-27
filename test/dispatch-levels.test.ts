/**
 * Dispatch against the real rule: every level the picker offers is accepted.
 *
 * Two readers decide whether a turn's saved thinking level survives. The
 * composer renders the Effort row the plane adapter answers, and dispatch
 * validates the saved effort with `getSupportedThinkingLevels` against the
 * model object the adapter built. Before P-R1 those were two decorators over
 * pi-ai's adapter, and when they disagreed `glm-5.3-flash-free` offered `high`
 * and `max` beside its name in the composer and answered
 * UNSUPPORTED_REASONING_EFFORT for both. Now both come from one rule
 * (`reasoningFor`, D1) folded into one model object (`planeModelFor`), so
 * this file is the check that the one rule and pi's agree.
 *
 * `test/model-metadata.test.ts` pins the rule against pi's levels for the
 * rule's own map. This file imports pi's rule ITSELF —
 * `getSupportedThinkingLevels` from the installed `@earendil-works/pi-ai`, the
 * function `dsh-llm-pi-ai` carries its own copy of and validates with — and
 * sweeps the whole shipped catalog on both planes through the model object
 * the plane adapter serves: for every model, **the levels the picker offers
 * are exactly the levels the rule accepts**. It needs no network and no port,
 * so it runs in the unit suite; the live, keyed half is
 * `test/e2e/dispatch-levels.e2e.ts`.
 *
 * @module test/dispatch-levels.test
 */

import { readFile } from "node:fs/promises";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";

import {
  type CatalogModelSpec,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  planeModelFor,
  type Protocol,
  protocolForSdk,
  reasoningFor,
} from "./support/src.ts";

/** The two plane routes, and the catalog and family map each resolves from. */
const PLANES = [
  {
    catalog: OPENCODE_ZEN_CATALOG,
    family: OPENCODE_FAMILY_API.zen,
    route: "opencode",
  },
  {
    catalog: OPENCODE_GO_CATALOG,
    family: OPENCODE_FAMILY_API.go,
    route: "opencode-go",
  },
] as const;

/** The model the plane adapter serves for one catalog row, on the default family. */
const servedModel = (
  plane: (typeof PLANES)[number],
  spec: CatalogModelSpec
): Readonly<Record<string, unknown>> & { api: Protocol; baseUrl: string } => {
  const { model, error } = planeModelFor({
    defaults: { contextWindow: 262_144, input: ["text"], maxTokens: 32_768 },
    endpoint: "modern",
    entry: { id: spec.id },
    familyApi: plane.family,
    route: plane.route,
    spec,
  });
  if (model === undefined) {
    throw new Error(`${plane.route}/${spec.id}: ${error}`);
  }
  return model;
};

/** The levels the picker offers for a served model, as effort ids. */
const offeredLevels = (
  spec: CatalogModelSpec,
  model: Readonly<Record<string, unknown>> & { api: Protocol }
): string[] =>
  reasoningFor(
    spec,
    model.api,
    model.compat as Readonly<Record<string, unknown>> | undefined
  )?.efforts.map((effort) => effort.id) ?? ["off"];

/**
 * The real rule. `getSupportedThinkingLevels` is typed against pi's `Model`
 * union; the served model is the shape it reads two fields off, so the cast
 * is the seam.
 */
const acceptedLevels = (model: unknown): string[] =>
  getSupportedThinkingLevels(model as never);

describe("the levels the picker offers are the levels dispatch accepts", () => {
  it("pins the deployed copy of the rule to the oracle it imports", async () => {
    // `dsh-llm-pi-ai` carries its own copy of the rule — that copy is what
    // the deployment validates with — and the oracle above imports the
    // original from `@earendil-works/pi-ai`. The two are one rule by
    // construction; this holds them together, so an upstream move fails here
    // rather than quietly validating against the wrong thing.
    const raw = await readFile(
      new URL(
        "../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
        import.meta.url
      ),
      "utf8"
    );
    const source = raw.replaceAll("!== void 0", "!== undefined");
    expect(
      source,
      "the deployed rule's reasoning-false branch left the bundle"
    ).toContain('if (!model.reasoning) return ["off"];');
    expect(
      source,
      "the deployed rule's xhigh/max requirement left the bundle"
    ).toContain(
      'if (level === "xhigh" || level === "max") return mapped !== undefined;'
    );
  });

  it("sweeps the whole catalog: the offered levels are exactly the accepted ones", () => {
    const problems: string[] = [];
    for (const plane of PLANES) {
      let checked = 0;
      for (const spec of plane.catalog) {
        const model = servedModel(plane, spec);
        // The catalog's protocol is the one dispatched on (D16).
        expect(model.api).toBe(protocolForSdk(spec.provider_npm));
        const offered = offeredLevels(spec, model);
        const accepted = acceptedLevels(model);
        if (offered.join(",") !== accepted.join(",")) {
          problems.push(
            `${plane.route} ${spec.id}: offers [${offered.join(", ")}], dispatch takes [${accepted.join(", ")}]`
          );
        }
        if (spec.reasoning === true) {
          checked += 1;
        }
      }
      // Anti-vacuity: a plane whose rows stopped reasoning (a parser change,
      // a catalog swap) must fail here, not pass by covering zero.
      expect(checked, `no ${plane.route} model reasons`).toBeGreaterThan(0);
    }
    expect(problems).toEqual([]);
  });

  it("a free Zen model offering several levels exists, and dispatch accepts every one (the shape of the reported bug)", () => {
    // `glm-5.3-flash-free` offered levels its dispatch refused: a free Zen
    // model offering more than one level. One rule now builds both, so
    // whatever it offers is taken. Nothing is dispatched here: the sweep
    // above compares every row, and this case guards it against the one
    // vacuity it cannot see, a catalog with no free Zen model offering more
    // than one level. The row is picked by that SHAPE — the
    // reporting id while the catalog still carries it, else the first free
    // Zen row offering more than one level — so a refresh that retires the
    // id keeps the case meaning the same thing rather than failing it.
    const [zen] = PLANES;
    const offersSeveral = (spec: CatalogModelSpec): boolean =>
      spec.is_free === true &&
      offeredLevels(spec, servedModel(zen, spec)).length > 1;
    const spec =
      zen.catalog.find(
        (row) => row.id === "glm-5.3-flash-free" && offersSeveral(row)
      ) ?? zen.catalog.find(offersSeveral);
    if (spec === undefined) {
      throw new TypeError(
        "no free Zen model offers more than one level: the reported shape is gone from the catalog"
      );
    }
    const model = servedModel(zen, spec);
    const offered = offeredLevels(spec, model);
    expect(offered.length).toBeGreaterThan(1);
    expect(acceptedLevels(model)).toEqual(offered);
  });
});
