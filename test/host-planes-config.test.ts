/**
 * The plugin owning the plane routes: how an edit flows through the claim,
 * and which routes are registered (tier B; D13).
 *
 * @module test/host-planes-config.test
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
import { clearCapturedApiKeys } from "./support/src.ts";

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
    clearCapturedApiKeys();
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
