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
 * The unit suite (`test/model-metadata.test.ts`) pins the rule against pi's
 * levels for the rule's own map. This file imports pi's rule ITSELF —
 * `getSupportedThinkingLevels` from the installed `@earendil-works/pi-ai`, the
 * function `dsh-llm-pi-ai` carries its own copy of and validates with — and
 * sweeps the whole shipped catalog on both planes through the model object
 * the plane adapter serves: for every model, **the levels the picker offers
 * are exactly the levels the rule accepts**.
 *
 * The last block is live and keyed: one toggle-only model per plane and
 * protocol, sent through the plane adapter on a tier-A host with the effort id
 * the picker's "On" carries, so the adapter builds the wire value and a
 * gateway that refuses it fails here rather than in a user's turn. It skips
 * without the plane's key, and when no toggle model was entitled on the
 * account (none reached the gateway's body check).
 *
 * Opt-in (`OPENCODE_E2E=1`), like every file in this suite. The sweep needs
 * no network and no port: its value is the real rule and the real catalog.
 */

import { readFile } from "node:fs/promises";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";

import {
  drainStream,
  fakeCredentials,
  mountTierA,
  waitForPlaneOwner,
} from "../support/host.ts";
import {
  type CatalogModelSpec,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  planeModelFor,
  type Protocol,
  protocolForSdk,
  reasoningFor,
} from "../support/src.ts";

const ENABLED = process.env.OPENCODE_E2E === "1";

/** The two plane routes, the catalog and family map each resolves from, and its key. */
const PLANES = [
  {
    catalog: OPENCODE_ZEN_CATALOG,
    family: OPENCODE_FAMILY_API.zen,
    key: process.env.OPENCODE_API_KEY,
    route: "opencode",
  },
  {
    catalog: OPENCODE_GO_CATALOG,
    family: OPENCODE_FAMILY_API.go,
    key: process.env.OPENCODE_GO_API_KEY,
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

describe.skipIf(!ENABLED)(
  "the levels the picker offers are the levels dispatch accepts",
  () => {
    it("pins the deployed copy of the rule to the oracle it imports", async () => {
      // `dsh-llm-pi-ai` carries its own copy of the rule — that copy is what
      // the deployment validates with — and the oracle above imports the
      // original from `@earendil-works/pi-ai`. The two are one rule by
      // construction; this holds them together, so an upstream move fails here
      // rather than quietly validating against the wrong thing.
      const raw = await readFile(
        new URL(
          "../../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
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

    it("dispatches the turn that reported the bug", () => {
      // `glm-5.3-flash-free` offered levels its dispatch refused. One rule
      // now builds both, so whatever it offers is taken.
      const [zen] = PLANES;
      const spec = zen.catalog.find((row) => row.id === "glm-5.3-flash-free");
      if (spec === undefined) {
        throw new TypeError("glm-5.3-flash-free left the Zen catalog");
      }
      const model = servedModel(zen, spec);
      const offered = offeredLevels(spec, model);
      expect(offered.length).toBeGreaterThan(1);
      expect(acceptedLevels(model)).toEqual(offered);
    });
  }
);

/** The first toggle-only model of each protocol on a plane: its efforts are named "On". */
const toggleModels = (
  plane: (typeof PLANES)[number]
): { spec: CatalogModelSpec; protocol: Protocol }[] => {
  const seen = new Map<Protocol, CatalogModelSpec>();
  for (const spec of plane.catalog) {
    const protocol = protocolForSdk(spec.provider_npm);
    if (protocol === undefined || seen.has(protocol)) {
      continue;
    }
    const reasoning = reasoningFor(spec, protocol);
    if (reasoning?.efforts.some((effort) => effort.name === "On") === true) {
      seen.set(protocol, spec);
    }
  }
  return [...seen].map(([protocol, spec]) => ({ protocol, spec }));
};

/** An answer about the account, not the wire: no paid access, no funds, rate limited. */
const ENTITLEMENT =
  /\b40[23]\b|\b429\b|access is disabled|Insufficient account funds/iu;

describe.skipIf(!ENABLED)(
  "live · a toggle model's On is a wire value the gateway takes",
  () => {
    const keyed = (plane: (typeof PLANES)[number]): boolean =>
      plane.key !== undefined && plane.key.length > 0;

    it.for(PLANES)(
      "$route: every toggle-only protocol accepts On through the plane adapter",
      { timeout: 120_000 },
      async (plane, context) => {
        // Without the plane's key there is nothing to send: reported as
        // skipped, never as a pass.
        context.skip(!keyed(plane), "no key for this plane");
        const toggles = toggleModels(plane);
        // Anti-vacuity: each plane carries at least one toggle-only model.
        expect(toggles.length).toBeGreaterThan(0);
        const ref =
          plane.route === "opencode"
            ? "OPENCODE_API_KEY"
            : "OPENCODE_GO_API_KEY";
        const tier = await mountTierA({
          credentials: fakeCredentials({ refs: { [ref]: plane.key ?? "" } }),
          plugin: {},
          providers: {
            [plane.route]: {
              apiKeyEnv: ref,
              models: toggles.map(({ spec }) => ({ id: spec.id })),
            },
          },
        });
        try {
          await waitForPlaneOwner(tier.llm, [plane.route]);
          const refused: string[] = [];
          let reached = 0;
          for (const { protocol, spec } of toggles) {
            // The id the picker's "On" carries, read from what the adapter
            // answers rather than assumed.
            const info = (await tier.llm.resolveModelInfo(
              plane.route,
              spec.id
            )) as { reasoning?: { efforts?: { id: string; name: string }[] } };
            const on = info.reasoning?.efforts?.find(
              (effort) => effort.name === "On"
            )?.id;
            expect(on, `${spec.id} offers no On`).toBeDefined();
            const drained = await drainStream(tier.llm, plane.route, spec.id, {
              reasoningEffort: on,
              signal: AbortSignal.timeout(60_000),
            });
            const message = drained.failureMessage ?? drained.error ?? "";
            if (ENTITLEMENT.test(message)) {
              continue;
            }
            reached += 1;
            if (
              drained.error !== undefined ||
              drained.finish?.kind === "error"
            ) {
              refused.push(`${spec.id} (${protocol}): ${message}`);
            }
          }
          // Every toggle model refused on entitlement: nothing about the wire
          // was observed, which is a skip, never a pass.
          context.skip(
            reached === 0,
            "no toggle model was entitled on this account"
          );
          expect(refused).toEqual([]);
        } finally {
          await tier.dispose();
        }
      }
    );
  }
);
