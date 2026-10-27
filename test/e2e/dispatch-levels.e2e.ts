/**
 * Dispatch against the real rule: every level the picker offers is accepted.
 *
 * Two readers decide whether a turn's saved thinking level survives. The
 * composer renders the Effort row from `ctx.llm.resolveModelInfo`, which
 * `decorateModelInfo` fills from our catalog; dispatch resolves the model
 * through the adapter's `modelOf`, which `decoratePlaneAdapters` fills, and
 * validates the saved effort with `getSupportedThinkingLevels`. When the two
 * disagreed, `glm-5.3-flash-free` offered `high` and `max` beside its name in
 * the composer and answered UNSUPPORTED_REASONING_EFFORT for both
 * (`fix(models): dispatch takes the levels the picker offers`).
 *
 * The unit suite pins the wrapper's logic against pi's rule copied into the
 * test. This file imports the rule ITSELF — `getSupportedThinkingLevels` from
 * the installed `@earendil-works/pi-ai`, the function `dsh-llm-pi-ai` carries
 * its own copy of and validates with — runs both real decorators on both sides,
 * and sweeps the whole shipped catalog on both planes: for every model,
 * **every level the picker offers is a level the rule accepts**. A vendor move
 * in the rule, or a catalog row the wrapper mishandles, fails here rather than
 * in a user's turn.
 *
 * Opt-in (`OPENCODE_E2E=1`), like every file in this suite. No network and no
 * port: the value is the real rule and the real catalog, not a socket.
 */

import { readFile } from "node:fs/promises";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  decorateModelInfo,
  decoratePlaneAdapters,
  resolveConfig,
} from "../support/src.ts";

const ENABLED = process.env.OPENCODE_E2E === "1";

/** The two plane routes, and the catalog each one's models resolve from. */
const PLANES = [
  { catalog: OPENCODE_ZEN_CATALOG, plane: "zen", route: "opencode" },
  { catalog: OPENCODE_GO_CATALOG, plane: "go", route: "opencode-go" },
] as const;

type Adapter = Record<string, unknown>;
type Registry = Map<string, { adapter: Adapter }>;

interface Fixture {
  /**
   * The one object the adapter answers per id, so a case can assert the
   * wrapper handed the adapter's own answer back — or filled a new one.
   */
  readonly answers: Map<string, Record<string, unknown>>;
  readonly llm: {
    readonly adapters: Registry;
    resolveModelInfo: (provider: string, model: string) => Promise<unknown>;
  };
}

/**
 * A Host LLM service as the decorators find it: a public `adapters` map keyed
 * by route, and a `resolveModelInfo` (the picker's read) answering the shape
 * pi's plane adapter does for an id its installed catalog does not carry —
 * `reasoning: false`, no level map. A foreign route rides along, because
 * "only the plane routes" is half the contract.
 */
const fixtureFor = (
  seed: (model: string) => Record<string, unknown>
): Fixture => {
  const answers = new Map<string, Record<string, unknown>>();
  const answer = (model: string): Record<string, unknown> => {
    const existing = answers.get(model);
    if (existing !== undefined) {
      return existing;
    }
    const made = seed(model);
    answers.set(model, made);
    return made;
  };
  const adapters: Registry = new Map();
  for (const route of [...PLANES.map((entry) => entry.route), "deepseek"]) {
    adapters.set(route, {
      adapter: {
        modelOf: (_snapshot: unknown, _provider: string, model: string) =>
          answer(model),
      },
    });
  }
  return {
    answers,
    llm: {
      adapters,
      resolveModelInfo: async (_provider: string, model: string) =>
        answer(model),
    },
  };
};

/** The adapter's own `modelOf`, typed for the call dispatch makes. */
const modelOfOn = (
  registry: Registry,
  route: string
): ((provider: string, model: string) => unknown) => {
  const method = registry.get(route)?.adapter.modelOf;
  if (typeof method !== "function") {
    throw new TypeError(`no modelOf on ${route}`);
  }
  return (provider: string, model: string): unknown =>
    (method as (snapshot: unknown, provider: string, model: string) => unknown)(
      undefined,
      provider,
      model
    );
};

/**
 * The real rule. `getSupportedThinkingLevels` is typed against pi's `Model`
 * union; the decorated answer is the shape `modelOf` returns and the rule
 * reads two fields off it, so the cast is the seam.
 */
const acceptedLevels = (answer: unknown): string[] =>
  getSupportedThinkingLevels(answer as never);

/** The Effort row `decorateModelInfo` rendered, as level ids. */
const offeredLevels = (info: unknown): string[] => {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const { reasoning } = info as { reasoning?: unknown };
  if (typeof reasoning !== "object" || reasoning === null) {
    return [];
  }
  const { efforts } = reasoning as { efforts?: unknown };
  if (!Array.isArray(efforts)) {
    return [];
  }
  const ids: string[] = [];
  for (const effort of efforts) {
    if (typeof effort === "object" && effort !== null) {
      const { id } = effort as { id?: unknown };
      if (typeof id === "string") {
        ids.push(id);
      }
    }
  }
  return ids;
};

describe.skipIf(!ENABLED)(
  "the levels the picker offers are the levels dispatch accepts",
  () => {
    const config = resolveConfig({ enrichModels: true });

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

    it("sweeps the whole catalog: every offered level is accepted", async () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: false,
      }));
      const stopAdapters = decoratePlaneAdapters(fixture.llm as never, config);
      const stopInfo = decorateModelInfo({ llm: fixture.llm } as never, config);
      const problems: string[] = [];
      try {
        for (const { catalog, plane, route } of PLANES) {
          let checked = 0;
          for (const spec of catalog) {
            const offered = offeredLevels(
              await fixture.llm.resolveModelInfo(route, spec.id)
            );
            if (offered.length === 0) {
              continue;
            }
            checked += 1;
            const accepted = acceptedLevels(
              modelOfOn(fixture.llm.adapters, route)(route, spec.id)
            );
            for (const level of offered) {
              if (!accepted.includes(level)) {
                problems.push(`${plane} ${spec.id}: dispatch refuses ${level}`);
              }
            }
          }
          // Anti-vacuity: a plane whose rows stopped offering levels (a parser
          // change, a catalog swap) must fail here, not pass by covering zero.
          expect(
            checked,
            `no ${plane} model offered a thinking level`
          ).toBeGreaterThan(0);
        }
      } finally {
        stopInfo?.();
        stopAdapters?.();
      }
      expect(problems).toEqual([]);
    });

    it("dispatches the turns that reported the bug", async () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: false,
      }));
      const stopAdapters = decoratePlaneAdapters(fixture.llm as never, config);
      const stopInfo = decorateModelInfo({ llm: fixture.llm } as never, config);
      try {
        const turns = [
          { id: "glm-5.3-flash-free", route: "opencode" },
          { id: "beam-free", route: "opencode" },
          { id: "beam-free", route: "opencode-go" },
        ] as const;
        for (const { id, route } of turns) {
          const offered = offeredLevels(
            await fixture.llm.resolveModelInfo(route, id)
          );
          // These two sat beside the model's name in the composer when the
          // turn came back UNSUPPORTED_REASONING_EFFORT.
          expect(offered, `${route} ${id} no longer offers high`).toContain(
            "high"
          );
          expect(offered, `${route} ${id} no longer offers max`).toContain(
            "max"
          );
          const accepted = acceptedLevels(
            modelOfOn(fixture.llm.adapters, route)(route, id)
          );
          expect(
            offered.filter((level) => !accepted.includes(level)),
            `${route} ${id}`
          ).toEqual([]);
          // The premise, on the object the adapter itself answered with:
          // without the fill, dispatch takes nothing but `off`, which is why
          // every offered level failed before the fix.
          const raw = fixture.answers.get(id);
          if (raw === undefined) {
            throw new TypeError(`the fixture never answered for ${id}`);
          }
          expect(acceptedLevels(raw)).toEqual(["off"]);
        }
      } finally {
        stopInfo?.();
        stopAdapters?.();
      }
    });

    it("fills only what the adapter refuses, and keeps every spelling it declares", () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: true,
        thinkingLevelMap: { high: "its-own-wire", low: null, xhigh: "X" },
      }));
      const stop = decoratePlaneAdapters(fixture.llm as never, config);
      try {
        const answer = modelOfOn(fixture.llm.adapters, "opencode")(
          "opencode",
          "beam-free"
        );
        const record = answer as {
          reasoning?: unknown;
          thinkingLevelMap?: Record<string, unknown>;
        };
        const map = record.thinkingLevelMap ?? {};
        expect(record.reasoning).toBe(true);
        // Its own wire spelling survives: an answer that takes a level keeps it.
        expect(map.high).toBe("its-own-wire");
        expect(map.xhigh).toBe("X");
        // A `null` entry is a REFUSAL, so it is filled from our catalog...
        expect(map.low).toBe("low");
        // ...and so is `max`: for xhigh/max an absent entry is not a level at
        // all, which is why the toggle rows gained them.
        expect(map.max).toBe("max");
        // A base level it leaves out keeps the LEVEL'S OWN NAME on the wire —
        // pi's rule for an absent base entry — so it is deliberately not filled.
        expect("medium" in map).toBe(false);
      } finally {
        stop?.();
      }
    });

    it("hands back the adapter's own object when nothing is refused", () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: true,
        thinkingLevelMap: { low: "L", max: "M", xhigh: "X" },
      }));
      const stop = decoratePlaneAdapters(fixture.llm as never, config);
      try {
        // cat-jam-free's offered levels are low, medium, high, xhigh and max:
        // the declared map takes low/xhigh/max, and medium and high are base
        // levels taken by omission — so there is nothing to fill. The call
        // creates the fixture's answer; the wrapper must hand THAT object back
        // rather than manufacture a new one.
        const answer = modelOfOn(fixture.llm.adapters, "opencode")(
          "opencode",
          "beam-free"
        );
        expect(answer).toBe(fixture.answers.get("beam-free"));
      } finally {
        stop?.();
      }
    });

    it("takes a toggle model's xhigh and max, spelled `on`", () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: false,
      }));
      const stop = decoratePlaneAdapters(fixture.llm as never, config);
      try {
        const answer = modelOfOn(fixture.llm.adapters, "opencode")(
          "opencode",
          "qwen3.6-plus"
        );
        const map = ((answer as { thinkingLevelMap?: unknown })
          .thinkingLevelMap ?? {}) as Record<string, unknown>;
        // A toggle model's wire value is `on` at every level, and before the
        // fix dispatch refused xhigh/max outright: an absent entry is not a
        // level for those two.
        expect(map.xhigh).toBe("on");
        expect(map.max).toBe("on");
        const accepted = acceptedLevels(answer);
        expect(accepted).toContain("xhigh");
        expect(accepted).toContain("max");
      } finally {
        stop?.();
      }
    });

    it("wraps the plane routes only, and only ids the catalog can describe", () => {
      const fixture = fixtureFor((model) => ({
        id: model,
        name: model,
        reasoning: false,
      }));
      const { adapters } = fixture.llm;
      const planeBefore = adapters.get("opencode")?.adapter.modelOf;
      const foreignBefore = adapters.get("deepseek")?.adapter.modelOf;
      const stop = decoratePlaneAdapters(fixture.llm as never, config);
      try {
        expect(adapters.get("deepseek")?.adapter.modelOf).toBe(foreignBefore);
        // An id in no catalog: the adapter's own answer, untouched.
        const unknown = modelOfOn(adapters, "opencode")(
          "opencode",
          "not-in-any-catalog"
        );
        expect(unknown).toBe(fixture.answers.get("not-in-any-catalog"));
      } finally {
        stop?.();
      }
      expect(adapters.get("opencode")?.adapter.modelOf).toBe(planeBefore);
      expect(adapters.get("deepseek")?.adapter.modelOf).toBe(foreignBefore);
    });
  }
);
