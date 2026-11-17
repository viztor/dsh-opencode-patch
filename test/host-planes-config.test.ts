/**
 * The plugin owning the plane routes: how an edit flows through the claim,
 * and which routes are registered (tier B; D13).
 *
 * @module test/host-planes-config.test
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  readProfilePatches,
  reconcileProfilePatches,
} from "@deepseek-ai/dsh-app-boot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  appendTo,
  bootPlanes,
  callConfigOf,
  disposeBooted,
  editProvider,
  planeProfile,
  type Providers,
  removeProviders,
  routeIds,
  settle,
  stateOf,
} from "./support/host-planes.ts";
import {
  characterizedProviders,
  FIBER_STATE,
  s0Providers,
  SAVE_CANDIDATE,
  until,
  waitForPlaneOwner,
  type TierA,
  type TierB,
} from "./support/host.ts";

let tierA: TierA | undefined;
let tierB: TierB | undefined;

afterEach(async () => {
  try {
    await tierA?.dispose();
    await tierB?.dispose();
    await disposeBooted();
  } finally {
    tierA = undefined;
    tierB = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("host planes · config flow (tier B)", { timeout: 30_000 }, () => {
  it("a plane-only save is served with no pi-ai restart; a displayName edit renames the route; a purge edit is accepted", async () => {
    const { restarts, tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = restarts();
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      appendTo("opencode", SAVE_CANDIDATE)
    );
    await until(async () => {
      const listed = await tier.llm.listModels("opencode");
      return listed.some((model) => model.id === SAVE_CANDIDATE);
    }, "the saved id is listed");
    expect(restarts() - before).toBe(0);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", { displayName: "Zen X" })
    );
    await until(
      () =>
        tier.llm.listProviders().find((provider) => provider.id === "opencode")
          ?.name === "Zen X",
      "the rename reaches the registry"
    );
    // The purge action's shape: an entry with a model removed.
    await tier.ctx.configEditor.edit(tier.piEntry, (current) => {
      const entry = (current.providers as Providers)["opencode-go"] as {
        models: { id: string }[];
      };
      return editProvider("opencode-go", {
        models: entry.models.filter((model) => model.id !== "minimax-m3"),
      })(current);
    });
    await until(async () => {
      const listed = await tier.llm.listModels("opencode-go");
      return !listed.some((model) => model.id === "minimax-m3");
    }, "the purged id leaves the listing");
  });

  it("a malformed plane candidate is refused in pi-ai's words, and the file is byte-identical", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        editProvider("opencode", { models: [{ id: "" }] })
      )
    ).rejects.toThrow(/has a model with an empty id/u);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
  });

  it("a save a sibling route refuses changes nothing: not the file, not the plane's listing, not its profile", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    const listed = await tier.llm.listModels("opencode");
    const profile = planeProfile(tier.llm, "opencode");
    await expect(
      tier.ctx.configEditor.edit(tier.piEntry, (current) =>
        appendTo(
          "opencode",
          SAVE_CANDIDATE
        )(editProvider("deepseek", { api: "nope" })(current))
      )
    ).rejects.toThrow();
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
    expect(await tier.llm.listModels("opencode")).toEqual(listed);
    expect(planeProfile(tier.llm, "opencode")).toBe(profile);
  });

  it("a save a home-level patch refuses changes nothing: not the file, not the plane's listing, not its profile", async () => {
    const { tier } = await bootPlanes();
    await waitForPlaneOwner(tier.llm);
    const before = readFileSync(tier.profile.patchPath);
    const listed = await tier.llm.listModels("opencode");
    const profile = planeProfile(tier.llm, "opencode");
    // A home patch pins pi-ai's row to the config it already has; the editor
    // refuses a profile edit whose result the home layer overrides.
    writeFileSync(
      join(tier.home, "cordis.patch.yml"),
      `${JSON.stringify([{ config: { providers: characterizedProviders() }, id: "llm-pi-ai" }], null, 2)}\n`
    );
    await expect(
      tier.ctx.configEditor.edit(
        tier.piEntry,
        appendTo("opencode", SAVE_CANDIDATE)
      )
    ).rejects.toThrow(/overridden by a home patch/u);
    expect(readFileSync(tier.profile.patchPath)).toEqual(before);
    expect(await tier.llm.listModels("opencode")).toEqual(listed);
    expect(planeProfile(tier.llm, "opencode")).toBe(profile);
  });

  it("a stored malformed entry leaves deepseek serving and answers INVALID_CONFIG for that one id only", async () => {
    const providers = s0Providers();
    (providers.opencode as { models: { id: string }[] }).models.push({
      id: "gpt-5.4",
    });
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm);
    expect(await callConfigOf(tier.llm, "opencode", "gpt-5.4")).toBe(
      "INVALID_CONFIG"
    );
    expect(await callConfigOf(tier.llm, "opencode", "deepseek-v4-pro")).toBe(
      "ok"
    );
    // The gap id pi's catalog does not describe resolves: the plugin, not
    // pi-ai, serves the plane.
    expect(
      await callConfigOf(tier.llm, "opencode", "gpt-5.3-codex-spark")
    ).toBe("ok");
    expect(routeIds(tier.llm)).toContain("deepseek");
  });

  it("a stored plane entry malformed at route level, which would fail pi-ai's whole fiber, leaves pi-ai active and deepseek serving, and that plane answers INVALID_CONFIG", async () => {
    const providers = s0Providers();
    // An invalid header name is a route-level error pi-ai raises for the
    // whole providers dict; the listener keeps it away from pi-ai.
    providers.opencode = {
      ...providers.opencode,
      headers: { "bad header": "x" },
    };
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm, ["opencode-go"]);
    await settle();
    expect(tier.piFiber.state).toBe(FIBER_STATE.ACTIVE);
    expect(await callConfigOf(tier.llm, "deepseek", "deepseek-v4-pro")).toBe(
      "ok"
    );
    expect(await callConfigOf(tier.llm, "opencode", "deepseek-v4-pro")).toBe(
      "INVALID_CONFIG"
    );
  });
});

describe("host planes · the route set (tier B)", { timeout: 30_000 }, () => {
  it("only the planes the profile declares are registered", async () => {
    const providers = s0Providers();
    delete providers["opencode-go"];
    const { tier } = await bootPlanes({ providers });
    await waitForPlaneOwner(tier.llm, ["opencode"]);
    expect(routeIds(tier.llm)).toEqual(["deepseek", "opencode"]);
  });

  it("a first plane added at runtime registers; removing both withdraws them through the live handle, and re-adding registers again", async () => {
    const { deepseek } = s0Providers();
    const { tier } = await bootPlanes({
      providers: { deepseek: deepseek ?? {} },
    });
    // The plugin's row is ACTIVE only once `apply` returned, and `apply`
    // awaits the claim's mount; the mount's own reconcile is queued in its
    // `finally`, which settle() lets run. Only then is the empty registry a
    // finding rather than a race.
    await until(
      () => stateOf(tier.pluginEntry?.fiber) === FIBER_STATE.ACTIVE,
      "the plugin's row is active"
    );
    await settle();
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    const zen = s0Providers().opencode ?? {};
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", zen)
    );
    await waitForPlaneOwner(tier.llm, ["opencode"]);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      removeProviders("opencode", "opencode-go")
    );
    await until(
      () => routeIds(tier.llm).length === 1,
      "the last plane is withdrawn"
    );
    expect(routeIds(tier.llm)).toEqual(["deepseek"]);
    await tier.ctx.configEditor.edit(
      tier.piEntry,
      editProvider("opencode", zen)
    );
    await waitForPlaneOwner(tier.llm, ["opencode"]);
  });
});

describe(
  "host planes · removing what pi cannot serve, before the plugin goes (tier B)",
  { timeout: 30_000 },
  () => {
    /** An id no pi and no catalog describes, declared with no route `api`. */
    const UNSERVED = "not-a-real-model";

    /** The purge service the plugin mounts on the root. */
    const purgeOf = (
      tier: TierB
    ): {
      readonly review: () => Promise<{
        readonly unserved: readonly { id: string; provider: string }[];
        readonly piRead: boolean;
      }>;
      readonly removeUnserved: () => Promise<{
        readonly removed: readonly { id: string; provider: string }[];
      }>;
    } => tier.ctx.get("opencodeModelPurge") as never;

    /**
     * The model ids the profile patch declares on `route`, read with the YAML
     * parser: every `providers.<route>.models` the patch's rows carry.
     */
    const declaredOn = (patch: string, route: string): string[] => {
      const ids: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) {
            walk(item);
          }
          return;
        }
        if (typeof value !== "object" || value === null) {
          return;
        }
        const record = value as Record<string, unknown>;
        const providers = record.providers as
          | Record<string, { models?: unknown }>
          | undefined;
        const models = providers?.[route]?.models;
        if (Array.isArray(models)) {
          for (const model of models) {
            ids.push(
              typeof model === "string" ? model : (model as { id: string }).id
            );
          }
        }
        for (const item of Object.values(record)) {
          walk(item);
        }
      };
      walk(parse(patch));
      return ids;
    };

    /** Boot with `opencode` declaring a pi-known id and {@link UNSERVED}. */
    const boot = async (): Promise<TierB> => {
      const { deepseek, opencode } = s0Providers();
      const { tier } = await bootPlanes({
        providers: {
          deepseek: deepseek ?? {},
          opencode: {
            apiKeyEnv: opencode?.apiKeyEnv,
            models: [{ id: "deepseek-v4-pro" }, { id: UNSERVED }],
          },
        },
      });
      await waitForPlaneOwner(tier.llm, ["opencode"]);
      await settle();
      return tier;
    };

    /**
     * Remove the plugin the way a profile edit reaches a running host: its row
     * disabled in the profile patch and the profile reloaded, so the loader
     * disposes its fiber and pi-ai serves the plane again.
     */
    const handBack = async (tier: TierB): Promise<void> => {
      const { pluginEntry } = tier;
      if (pluginEntry === undefined) {
        throw new Error("no plugin row");
      }
      // YAML, not JSON: a config editor write leaves the patch in YAML, and
      // JSON is YAML too, so one parser reads either.
      const rows = parse(
        readFileSync(tier.profile.patchPath, "utf8")
      ) as unknown[];
      writeFileSync(
        tier.profile.patchPath,
        `${JSON.stringify([...rows, { disabled: true, id: pluginEntry.options.id }], null, 2)}\n`
      );
      await reconcileProfilePatches(
        tier.ctx as never,
        readProfilePatches("dsh", tier.profile),
        "dsh"
      );
      await until(
        () => pluginEntry.fiber === undefined || pluginEntry.fiber.uid === null,
        "the plugin row is disposed"
      );
      await waitForPlaneOwner(tier.llm, ["opencode"], "PiAiAdapter");
      await settle();
    };

    it("the card's removal clears what pi cannot serve, in one write, and the handback's next Settings edit is then accepted", async () => {
      const tier = await boot();
      const service = purgeOf(tier);
      const review = await service.review();
      // Exactly the unknown id: `deepseek-v4-pro` is in pi's installed
      // catalog on every cell, so a review or removal that over-lists (a
      // lookup under the wrong route among them) fails here.
      expect(review.piRead).toBe(true);
      expect(review.unserved).toEqual([{ id: UNSERVED, provider: "opencode" }]);

      const edits = vi.spyOn(tier.ctx.configEditor, "edit");
      const before = readFileSync(tier.profile.patchPath, "utf8");
      const result = await service.removeUnserved();
      expect(result.removed).toEqual([{ id: UNSERVED, provider: "opencode" }]);
      expect(edits).toHaveBeenCalledTimes(1);
      const after = readFileSync(tier.profile.patchPath, "utf8");
      expect(after).not.toBe(before);
      expect(after).not.toContain(UNSERVED);
      expect(declaredOn(after, "opencode")).toEqual(["deepseek-v4-pro"]);
      await until(async () => {
        const listed = await tier.llm.listModels("opencode");
        return !listed.some((model) => model.id === UNSERVED);
      }, "the removed id leaves the listing");
      edits.mockRestore();

      await handBack(tier);
      await expect(
        tier.ctx.configEditor.edit(
          tier.piEntry,
          appendTo("opencode", "gpt-5.4")
        )
      ).resolves.not.toThrow();
    });

    it("the control: without the removal, the handback's next Settings edit is refused in pi-ai's words", async () => {
      const tier = await boot();
      await handBack(tier);
      await expect(
        tier.ctx.configEditor.edit(
          tier.piEntry,
          appendTo("opencode", "gpt-5.4")
        )
      ).rejects.toThrow(/needs an api/u);
    });
  }
);
