/**
 * The config editor, the loader's volatile commit and the settings forms,
 * pinned on the real host (tier B).
 *
 * The route-claim design keeps the user's file whole while pi-ai's resolved
 * config loses the two planes (docs/improvement-plan.md, F12-F16, F20). That
 * only works if the editor writes the raw value it was handed, if a commit can
 * be told from the editor's validation run by identity, if a plane-only edit
 * re-registers nothing, and if the settings page reads what these cases say
 * it reads. Each case boots a fresh host and names the host file and line it
 * pins; references are into `deepseek-harness`'s `packages/` and `vendor/`.
 *
 * These are host contracts, so the plugin's own row is left out (its hidden
 * mount would add registry events of its own) except where the plugin's row is
 * the subject (F16).
 *
 * @module test/host-editor-contracts.test
 */
import { readFileSync } from "node:fs";

import type { Context, Fiber } from "@deepseek-ai/cordis";
import { readProfilePatches } from "@deepseek-ai/dsh-app-boot";
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptersOf,
  bootTierB,
  drainStream,
  fakeCredentials,
  modelsPageRows,
  planeKeysOnly,
  PLANES,
  providerWithApiKey,
  recordingFetch,
  s0Providers,
  type TierB,
  waitForPlaneOwner,
  waterfallSpy,
  withoutPlanes,
} from "./support/host.ts";

/** The listener the claim design installs, prepended on the root. */
function stripPlanesForPiAi(
  this: Fiber,
  raw: unknown,
  next: () => unknown
): unknown {
  if (this.runtime?.name !== "llm-pi-ai") {
    return next();
  }
  const copy = withoutPlanes(raw);
  next();
  return copy;
}

const prependStrip = (root: Context): void => {
  root.on("internal/config", stripPlanesForPiAi, { prepend: true });
};

/** S0 without the ids pi 1.1.0 cannot place, so pi-ai's save check passes. */
const knownProviders = (): Record<string, Record<string, unknown>> => {
  const providers = s0Providers();
  const gaps = new Set([
    "gpt-5.3-codex-spark",
    "gemini-4-argon-contributor",
    "minimax-m3.1-flash",
  ]);
  for (const plane of ["opencode", "opencode-go"]) {
    const entry = providers[plane] as { models: { id: string }[] };
    entry.models = entry.models.filter((model) => !gaps.has(model.id));
  }
  return providers;
};

type ProviderDict = Record<string, Record<string, unknown>>;

/** An edit of one provider entry, the way a settings surface derives one. */
const editProvider =
  (route: string, patch: Record<string, unknown>) =>
  (current: Record<string, unknown>): Record<string, unknown> => {
    const providers = current.providers as ProviderDict;
    return {
      ...current,
      providers: { ...providers, [route]: { ...providers[route], ...patch } },
    };
  };

/** The last pi-ai row with a config in the profile, read through the host. */
const savedPiRow = (tier: TierB): { providers: ProviderDict } => {
  const row = readProfilePatches("dsh", tier.profile).findLast(
    (patch) => patch.id === "llm-pi-ai" && patch.config !== undefined
  );
  return row?.config as { providers: ProviderDict };
};

const resolvedKeys = (fiber: Fiber | undefined): string[] => {
  const config = fiber?.config as
    | { providers: { get: () => Record<string, unknown> } }
    | undefined;
  return Object.keys(config?.providers.get() ?? {});
};

/** The provider keys one side of a settings descriptor holds. */
const providerKeys = (side: unknown): string[] =>
  Object.keys((side as { providers?: object } | undefined)?.providers ?? {});

/** The refs `credentials.describe` was asked about from `from` on. */
const describedRefs = (tier: TierB, from: number): string[] =>
  tier.credentials.calls
    .slice(from)
    .filter(([method]) => method === "describe")
    .map(([, ref]) => ref);

const routeIds = (tier: TierB): string[] =>
  tier.llm.listProviders().map((provider) => provider.id);

let tier: TierB | undefined;

afterEach(async () => {
  await tier?.dispose();
  tier = undefined;
  vi.unstubAllGlobals();
});

describe(
  "host · the config editor and the volatile commit (tier B)",
  {
    timeout: 30_000,
  },
  () => {
    it("writes the raw next to the profile YAML, not the resolved value (config-editor/src/index.ts:100-128,142)", async () => {
      tier = await bootTierB({
        plugin: false,
        prepare: prependStrip,
        providers: knownProviders(),
      });
      expect(routeIds(tier)).toEqual(["deepseek"]);
      await tier.ctx.configEditor.edit(
        tier.piEntry,
        editProvider("opencode", { displayName: "Zen (edited)" })
      );
      const saved = savedPiRow(tier);
      expect(saved.providers.opencode?.displayName).toBe("Zen (edited)");
      expect(Object.keys(saved.providers).toSorted()).toEqual([
        "deepseek",
        "opencode",
        "opencode-go",
      ]);
      // The editor's own read of the file agrees.
      const override = tier.ctx.configEditor
        .configuration()
        .find((row) => row.entry === tier?.piEntry)?.override as {
        providers: ProviderDict;
      };
      expect(override.providers.opencode?.displayName).toBe("Zen (edited)");
      // The fiber keeps the raw it was handed, and resolves the stripped copy.
      expect(resolvedKeys(tier.piFiber)).toEqual(["deepseek"]);
      const raw = (
        tier.piFiber as unknown as { _config: { providers: ProviderDict } }
      )._config;
      expect(raw.providers.opencode?.displayName).toBe("Zen (edited)");
    });

    it("F14 — the editor's candidate is never fiber._config; _commitVolatile's run is (config-editor:103; loader entry.ts:149,171)", async () => {
      tier = await bootTierB({
        plugin: false,
        prepare: prependStrip,
        providers: knownProviders(),
      });
      const booted = tier;
      const spy = waterfallSpy(booted.ctx, () => booted.piEntry.fiber);
      await booted.ctx.configEditor.edit(
        booted.piEntry,
        editProvider("opencode", { displayName: "Zen (edited)" })
      );
      expect(spy.records.map((record) => record.isCommit)).toEqual([
        false,
        true,
      ]);
      const [, commit] = spy.records;
      expect(commit?.raw).toBe(booted.piEntry.options.config);
      expect(commit?.raw).toBe(
        (booted.piFiber as unknown as { _config: unknown })._config
      );
      expect(spy.records[0]?.raw).not.toBe(commit?.raw);
    });

    it("F15 — a plane-only edit emits no loader/volatile-update and restarts nothing; a sibling's edit emits one (loader entry.ts:177-191)", async () => {
      tier = await bootTierB({
        plugin: false,
        prepare: prependStrip,
        providers: knownProviders(),
      });
      const volatile: unknown[] = [];
      let adaptersUpdated = 0;
      tier.ctx.on(
        "loader/volatile-update",
        (paths: unknown) => {
          volatile.push(paths);
        },
        { global: true }
      );
      tier.ctx.on(
        "llm/adapters-updated",
        () => {
          adaptersUpdated += 1;
        },
        { global: true }
      );
      const before = tier.piEntry.fiber;
      await tier.ctx.configEditor.edit(
        tier.piEntry,
        editProvider("opencode", { displayName: "Zen (edited)" })
      );
      expect(volatile).toEqual([]);
      expect(adaptersUpdated).toBe(0);
      expect(tier.piEntry.fiber).toBe(before);
      expect(tier.piFiber.state).toBe(2);
      expect(routeIds(tier)).toEqual(["deepseek"]);

      // Control: an edit pi-ai DOES see commits one volatile update, and pi-ai
      // re-registers in place — the route replace and the directory replace
      // each announce (llm/src/index.ts:475,536) — without a restart.
      await tier.ctx.configEditor.edit(
        tier.piEntry,
        editProvider("deepseek", { displayName: "DS (edited)" })
      );
      expect(volatile).toEqual([[["providers"]]]);
      expect(adaptersUpdated).toBe(2);
      expect(tier.piEntry.fiber).toBe(before);
      expect(tier.llm.listProviders()).toEqual([
        { id: "deepseek", name: "DS (edited)" },
      ]);
    });

    it("the stripping listener does not shield pi-ai's own save check: with a gap id stored, a plane edit is refused and the file is untouched (llm-pi-ai/src/index.ts:177-186; config.ts:364-368)", async () => {
      // Read for P-R1. An outermost listener's copy is what the fiber KEEPS,
      // but pi-ai validates the value its inner chain returns — the editor's
      // raw candidate — and against its stripped previous config every plane
      // entry reads as changed, so the strict check runs on it.
      tier = await bootTierB({
        plugin: false,
        prepare: prependStrip,
        providers: s0Providers(),
      });
      const booted = tier;
      const spy = waterfallSpy(booted.ctx, () => booted.piEntry.fiber);
      const before = readFileSync(booted.profile.patchPath);
      await expect(
        booted.ctx.configEditor.edit(
          booted.piEntry,
          editProvider("opencode", { displayName: "Zen (edited)" })
        )
      ).rejects.toThrow(
        /provider "opencode" model "gpt-5\.3-codex-spark" needs an api/u
      );
      expect(spy.records.map((record) => record.isCommit)).toEqual([false]);
      expect(readFileSync(booted.profile.patchPath)).toEqual(before);
    });
  }
);

describe("host · settings.describe (tier B)", { timeout: 30_000 }, () => {
  it("host contract, F20 — builds value from the resolved fiber config while user keeps the YAML's entries (settings/src/index.ts:319-322)", async () => {
    tier = await bootTierB({
      plugin: false,
      prepare: prependStrip,
      providers: s0Providers(),
    });
    const stripped = tier.ctx.settings
      .describe()
      .find((descriptor) => descriptor.ns === "llm-pi-ai");
    expect(providerKeys(stripped?.value)).toEqual(["deepseek"]);
    expect(providerKeys(stripped?.user).toSorted()).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
    ]);
    expect(stripped?.applies).toBe("live");
  });

  it("host contract, F20 control — with no listener, value carries every entry the YAML holds", async () => {
    tier = await bootTierB({ plugin: false, providers: s0Providers() });
    const plain = tier.ctx.settings
      .describe()
      .find((descriptor) => descriptor.ns === "llm-pi-ai");
    expect(providerKeys(plain?.value).toSorted()).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
    ]);
  });
});

describe(
  "host · session-controller's hasProviderApiKey, restated (tier B, no plugin row)",
  { timeout: 30_000 },
  () => {
    // Host contracts, measured without the plugin, so nothing in src/ can move
    // them. The with-plugin row P-R1 must keep green is the [BASELINE] case in
    // test/host-characterization.test.ts.
    it("host contract — with only the plane keys stored, the Zen plane answers it: its describe().value carries apiKeyEnv and the key is configured", async () => {
      tier = await bootTierB({
        credentials: planeKeysOnly(),
        plugin: false,
        providers: s0Providers(),
      });
      const from = tier.credentials.calls.length;
      expect(await providerWithApiKey(tier)).toBe("opencode");
      expect(describedRefs(tier, from)).toContain("OPENCODE_API_KEY");
    });

    it("host contract, control — with no key stored it answers false, and with only DEEPSEEK_API_KEY the sibling answers it", async () => {
      tier = await bootTierB({ plugin: false, providers: s0Providers() });
      expect(await providerWithApiKey(tier)).toBeUndefined();
      await tier.dispose();
      tier = await bootTierB({
        credentials: fakeCredentials({ refs: { DEEPSEEK_API_KEY: "ds" } }),
        plugin: false,
        providers: s0Providers(),
      });
      expect(await providerWithApiKey(tier)).toBe("deepseek");
    });

    it("host contract, F20 — under a test-local strip it answers FALSE with the plane keys stored: the directory still lists the planes, but their describe().value is gone, so their keys are never asked about", async () => {
      // Why P-R1 needs the settings.describe wrapper (D18): upstream, false
      // here makes initializeDefaultModel replace the user's default with the
      // account's first model. The strip is this file's own listener, not the
      // plugin, so this case cannot flip; what P-R1 must keep green while its
      // own strip is active is the with-plugin [BASELINE] in
      // test/host-characterization.test.ts.
      tier = await bootTierB({
        credentials: planeKeysOnly(),
        plugin: false,
        prepare: prependStrip,
        providers: s0Providers(),
      });
      for (const plane of ["opencode", "opencode-go"]) {
        expect(tier.llm.listConfigurableProviders()).toContainEqual(
          expect.objectContaining({
            provider: plane,
            settingsNs: "llm-pi-ai",
            settingsPath: ["providers", plane],
          })
        );
      }
      const from = tier.credentials.calls.length;
      expect(await providerWithApiKey(tier)).toBeUndefined();
      expect(describedRefs(tier, from)).toEqual(["DEEPSEEK_API_KEY"]);
    });
  }
);

describe(
  "host · !!js and the outermost listener (tier B)",
  { timeout: 30_000 },
  () => {
    it("F16 — the outermost listener sees an un-interpolated {__jsExpr} node; the fiber's config holds the evaluated value (loader/src/index.ts:104-113)", async () => {
      // The expression evaluates to the NON-default value (`debug` defaults
      // to false), so a value that fell back to the default cannot pass.
      const wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      const seen: unknown[] = [];
      tier = await bootTierB({
        prepare: (root) => {
          root.on(
            "internal/config",
            function recordPluginRaw(
              this: Fiber,
              raw: unknown,
              next: () => unknown
            ) {
              if (this.runtime?.name === "dsh-opencode-patch") {
                seen.push(raw);
              }
              return next();
            },
            { prepend: true }
          );
        },
        profilePatchYaml: [
          "- id: dsh-opencode-patch",
          "  config:",
          '    debug: !!js "1 < 2"',
          "",
        ].join("\n"),
      });
      expect(seen.length).toBeGreaterThan(0);
      expect((seen[0] as { debug: unknown }).debug).toEqual({
        __jsExpr: "1 < 2",
      });
      const pluginConfig = tier.pluginEntry?.fiber?.config as
        | { debug: unknown }
        | undefined;
      expect(pluginConfig?.debug).toBe(true);
    });

    it("F16 on pi-ai's row — a !!js node inside a provider profile boots evaluated, but pi-ai's own check refuses every later save of the row (llm-pi-ai/src/index.ts:177-180)", async () => {
      // Read for P-R1: pi-ai's listener runs `Config(raw)` on the value its
      // inner chain returns, which the loader has not interpolated yet, so a
      // `!!js` node inside `providers` survives boot and blocks the editor.
      tier = await bootTierB({
        plugin: false,
        profilePatchYaml: [
          "- id: llm-pi-ai",
          "  config:",
          "    providers:",
          "      deepseek:",
          "        apiKeyEnv: DEEPSEEK_API_KEY",
          '        displayName: !!js \'"D" + "S"\'',
          "",
        ].join("\n"),
      });
      expect(tier.llm.listProviders()).toEqual([
        { id: "deepseek", name: "DS" },
      ]);
      await expect(
        tier.ctx.configEditor.edit(
          tier.piEntry,
          editProvider("deepseek", { baseURL: "http://127.0.0.1:9/v1" })
        )
      ).rejects.toThrow(
        "$.providers.deepseek.displayName expected string but got [object Object]"
      );
    });
  }
);

/** pi-ai's descriptor value for a provider, as `settings.describe()` builds it. */
const describedEntry = (host: TierB, provider: string): unknown =>
  (
    host.ctx.settings
      .describe()
      .find((descriptor) => descriptor.ns === "llm-pi-ai")?.value as
      | { providers?: Record<string, unknown> }
      | undefined
  )?.providers?.[provider];

/** pi-ai's own resolved profile for a route, without its built provider. */
const piAiProfile = (host: TierB, route: string): Record<string, unknown> => {
  const adapter = adaptersOf(host.llm).get(route)?.adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, Record<string, unknown>> };
  };
  const { piProvider: _provider, ...rest } =
    adapter.config.profiles().get(route) ?? {};
  return rest;
};

describe(
  "contract · the plugin's Settings graft and pi-ai's own routes (tier B, D18)",
  { timeout: 30_000 },
  () => {
    it("the graft gives each plane exactly the entry pi-ai's Config resolves from the file, the value a plugin-less boot shows, and leaves the revision alone", async () => {
      vi.stubGlobal("fetch", recordingFetch().fetch);
      tier = await bootTierB({ providers: s0Providers() });
      await waitForPlaneOwner(tier.llm);
      const resolved = (
        LlmPiAi.Config({ providers: s0Providers() } as never) as unknown as {
          providers: { get: () => Record<string, unknown> };
        }
      ).providers.get();
      const grafted = Object.fromEntries(
        PLANES.map((plane) => [plane, describedEntry(tier!, plane)])
      );
      for (const plane of PLANES) {
        expect(grafted[plane], plane).toEqual(resolved[plane]);
      }
      /** What the graft must not touch: the descriptor's revision, base and user layers. */
      const untouched = (host: TierB) => {
        const descriptor = host.ctx.settings
          .describe()
          .find((entry) => entry.ns === "llm-pi-ai") as
          | { revision?: unknown; base?: unknown; user?: unknown }
          | undefined;
        return {
          base: descriptor?.base,
          revision: descriptor?.revision,
          user: descriptor?.user,
        };
      };
      const withPlugin = untouched(tier);
      expect(withPlugin.revision).toBeDefined();
      expect(withPlugin.user).toBeDefined();
      await tier.dispose();
      tier = await bootTierB({ plugin: false, providers: s0Providers() });
      for (const plane of PLANES) {
        expect(describedEntry(tier, plane), plane).toEqual(grafted[plane]);
      }
      // The same profile booted without the plugin: the same revision, and
      // the same base and user layers, so the graft changed only `value`.
      expect(untouched(tier)).toEqual(withPlugin);
    });

    it("the Models page reads both planes configured under the profile's own apiKeyEnv, a custom one included, and a key typed under it authenticates the plane", async () => {
      vi.stubGlobal("fetch", recordingFetch().fetch);
      tier = await bootTierB({ providers: s0Providers() });
      await waitForPlaneOwner(tier.llm);
      expect(modelsPageRows(tier)).toEqual({
        opencode: { apiKeyEnv: "OPENCODE_API_KEY", configured: true },
        "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY", configured: true },
      });
      await tier.dispose();
      const wire = recordingFetch();
      vi.stubGlobal("fetch", wire.fetch);
      const providers = s0Providers();
      providers.opencode!.apiKeyEnv = "MY_ZEN_KEY";
      const credentials = fakeCredentials();
      tier = await bootTierB({ credentials, providers });
      await waitForPlaneOwner(tier.llm);
      expect(modelsPageRows(tier).opencode).toEqual({
        apiKeyEnv: "MY_ZEN_KEY",
        configured: true,
      });
      await (
        credentials.service.set as unknown as (
          ref: string,
          value: string
        ) => Promise<void>
      )("MY_ZEN_KEY", "typed");
      await drainStream(tier.llm, "opencode", "deepseek-v4-pro");
      const sent = wire.requests.find(
        (request) => !request.url.startsWith("https://models.opencode.ai/")
      );
      expect(sent?.headers.authorization).toBe("Bearer typed".length);
    });

    it("parity on a route that is not a plane: pi-ai's resolved deepseek profile is the same with and without the plugin", async () => {
      vi.stubGlobal("fetch", recordingFetch().fetch);
      tier = await bootTierB({ providers: s0Providers() });
      await waitForPlaneOwner(tier.llm);
      const withPlugin = piAiProfile(tier, "deepseek");
      await tier.dispose();
      tier = await bootTierB({ plugin: false, providers: s0Providers() });
      expect(withPlugin).toEqual(piAiProfile(tier, "deepseek"));
      expect(Object.keys(withPlugin)).toContain("retryPolicy");
    });
  }
);
