/**
 * Which plane entries the route claim takes, and which it leaves to pi-ai
 * because another plugin owns them (`src/utils/plane-ownership.ts`, D27).
 *
 * Pure: a row's realm label and a raw config in, a decision out. The realm
 * labels follow the loader's own reading (`cordis-plugin-loader`
 * `config/isolate.ts`): `true` is a realm private to its row, a non-empty
 * string one shared by label, anything falsy no realm at all.
 *
 * @module test/plane-ownership.test
 */
import { describe, expect, it } from "vitest";

import {
  credentialsRealmKeyOf,
  credentialsRealmOf,
  foreignCredentialsRealm,
  isForeignRealm,
  PLUGIN_MARKER_HEADER,
  pluginMarkerOf,
  stepAsideMessage,
  steppedAsidePlanes,
  takenPlanes,
} from "./support/src.ts";

const MARKED = { headers: { [PLUGIN_MARKER_HEADER]: "vendor/1.0.0" } };

describe("plane-ownership · the realm a row resolves credentials in", () => {
  it("reads the loader's label, and nothing falsy or of another shape", () => {
    expect(credentialsRealmOf({ isolate: { credentials: "vendor" } })).toBe(
      "vendor"
    );
    expect(credentialsRealmOf({ isolate: { credentials: true } })).toBe(true);
    for (const options of [
      undefined,
      null,
      "row",
      {},
      { isolate: null },
      { isolate: "credentials" },
      { isolate: { credentials: "" } },
      { isolate: { credentials: false } },
      { isolate: { credentials: 1 } },
      { isolate: { other: "vendor" } },
    ]) {
      expect(credentialsRealmOf(options)).toBeUndefined();
    }
  });

  it("is foreign unless both rows name the same shared realm", () => {
    expect(isForeignRealm(undefined, undefined)).toBe(false);
    expect(isForeignRealm(undefined, "vendor")).toBe(false);
    expect(isForeignRealm("vendor", "vendor")).toBe(false);
    expect(isForeignRealm("vendor", undefined)).toBe(true);
    expect(isForeignRealm("vendor", "other")).toBe(true);
    // A private realm is its row's alone, whatever the plugin's row says.
    expect(isForeignRealm(true, true)).toBe(true);
    expect(isForeignRealm(true, undefined)).toBe(true);
  });
});

describe("plane-ownership · the realm each context RESOLVES (cordis's own key)", () => {
  /** cordis keys a context's per-service realms by this symbol. */
  const ISOLATE = Symbol.for("cordis.isolate");
  const GLOBAL = Symbol("credentials");
  const TEAM = Symbol("credentials@team");
  const OTHER = Symbol("credentials@other");
  /** A realm map; `parent` is the map it inherits from, as the loader builds it. */
  const realmMap = (
    parent: object | null,
    own: Record<string, unknown> = {}
  ): object => Object.assign(Object.create(parent), own);
  const rootMap = realmMap(null, { credentials: GLOBAL });
  const contextOf = (map: object): object => ({ [ISOLATE]: map });
  const root = contextOf(rootMap);
  const unisolated = contextOf(realmMap(rootMap));
  const team = contextOf(realmMap(rootMap, { credentials: TEAM }));
  const other = contextOf(realmMap(rootMap, { credentials: OTHER }));
  /** A row inside a group isolated into "team", with no realm of its own. */
  const inTeamGroup = contextOf(
    realmMap(realmMap(rootMap, { credentials: TEAM }))
  );

  it("reads the key a context resolves credentials under, inherited or own, and nothing from a context without a realm map", () => {
    expect(credentialsRealmKeyOf(team)).toEqual({ key: TEAM });
    expect(credentialsRealmKeyOf(inTeamGroup)).toEqual({ key: TEAM });
    expect(credentialsRealmKeyOf(unisolated)).toEqual({ key: GLOBAL });
    expect(credentialsRealmKeyOf(contextOf(realmMap(null)))).toEqual({
      key: undefined,
    });
    for (const context of [undefined, null, "ctx", {}, { [ISOLATE]: 1 }]) {
      expect(credentialsRealmKeyOf(context)).toBeUndefined();
    }
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error("no realm map here");
        },
      }
    );
    expect(credentialsRealmKeyOf(throwing)).toBeUndefined();
  });

  it("is foreign when pi-ai's row is isolated into a realm the plugin's context does not resolve, by key, whatever the rows' own labels say", () => {
    const teamRow = { isolate: { credentials: "team" } };
    // Isolated, and the plugin is not in it: foreign, named by the row's label.
    expect(
      foreignCredentialsRealm(
        { context: team, options: teamRow },
        { context: unisolated, options: {} },
        root
      )
    ).toEqual({ realm: "team" });
    expect(
      foreignCredentialsRealm(
        { context: team, options: teamRow },
        { context: other, options: { isolate: { credentials: "other" } } },
        root
      )
    ).toEqual({ realm: "team" });
    // The plugin inherits pi-ai's realm from a group: the same key, so shared.
    expect(
      foreignCredentialsRealm(
        { context: team, options: teamRow },
        { context: inTeamGroup, options: {} },
        root
      )
    ).toBeUndefined();
    // pi-ai inherits a realm from a group the plugin is outside of: foreign,
    // though its row names no realm.
    expect(
      foreignCredentialsRealm(
        { context: inTeamGroup, options: {} },
        { context: unisolated, options: {} },
        root
      )
    ).toEqual({ realm: undefined });
    // pi-ai on the process-wide realm is never foreign, wherever the plugin is.
    expect(
      foreignCredentialsRealm(
        { context: unisolated, options: {} },
        { context: team, options: teamRow },
        root
      )
    ).toBeUndefined();
    // Nothing has provided credentials anywhere yet: no realm to differ.
    const bare = contextOf(realmMap(null));
    expect(
      foreignCredentialsRealm(
        { context: contextOf(realmMap(null)), options: {} },
        { context: bare, options: {} },
        bare
      )
    ).toBeUndefined();
  });

  it("falls back to the rows' labels when either context carries no realm map", () => {
    const vendor = { isolate: { credentials: "vendor" } };
    expect(
      foreignCredentialsRealm({ options: vendor }, { options: {} }, undefined)
    ).toEqual({ realm: "vendor" });
    expect(
      foreignCredentialsRealm(
        { context: team, options: vendor },
        { options: vendor },
        root
      )
    ).toBeUndefined();
    expect(
      foreignCredentialsRealm({ options: {} }, { context: team }, root)
    ).toBeUndefined();
  });
});

describe("plane-ownership · the marker", () => {
  it("finds the header in any case, as written", () => {
    expect(pluginMarkerOf(MARKED)).toBe(PLUGIN_MARKER_HEADER);
    expect(pluginMarkerOf({ headers: { "X-OpenCode-Plugin": "v" } })).toBe(
      "X-OpenCode-Plugin"
    );
    for (const entry of [
      undefined,
      null,
      {},
      { headers: null },
      { headers: "x-opencode-plugin" },
      { headers: { "x-opencode-plugins": "v", "x-other": "v" } },
    ]) {
      expect(pluginMarkerOf(entry)).toBeUndefined();
    }
  });
});

describe("plane-ownership · what the claim takes", () => {
  const raw = {
    providers: { deepseek: MARKED, opencode: MARKED, "opencode-go": {} },
  };

  it("leaves a marked entry to pi-ai and takes the unmarked one beside it", () => {
    expect([...steppedAsidePlanes(raw, undefined)]).toEqual([
      ["opencode", { header: PLUGIN_MARKER_HEADER, kind: "marker" }],
    ]);
    expect(takenPlanes(raw, undefined)).toEqual(["opencode-go"]);
  });

  it("leaves every declared plane to pi-ai in a foreign realm, the realm named over the marker", () => {
    expect([...steppedAsidePlanes(raw, { realm: "vendor" })]).toEqual([
      ["opencode", { kind: "realm", realm: "vendor" }],
      ["opencode-go", { kind: "realm", realm: "vendor" }],
    ]);
    expect(takenPlanes(raw, { realm: "vendor" })).toEqual([]);
  });

  it("takes every declared plane of a plain row (the known answer), and nothing of a config without planes", () => {
    const plainRow = { providers: { opencode: {}, "opencode-go": {} } };
    expect(steppedAsidePlanes(plainRow, undefined).size).toBe(0);
    expect(takenPlanes(plainRow, undefined)).toEqual([
      "opencode",
      "opencode-go",
    ]);
    for (const config of [undefined, null, {}, { providers: null }]) {
      expect(steppedAsidePlanes(config, { realm: "vendor" }).size).toBe(0);
      expect(takenPlanes(config, undefined)).toEqual([]);
    }
    expect(takenPlanes({ providers: { deepseek: {} } }, undefined)).toEqual([]);
  });
});

describe("plane-ownership · the line the claim logs", () => {
  it("names the route, the row, and the reason, and says the route is pi-ai's", () => {
    expect(
      stepAsideMessage(
        "opencode",
        { kind: "realm", realm: "vendor" },
        "llm-pi-ai"
      )
    ).toBe(
      'the pi-ai row "llm-pi-ai" resolves credentials in the realm "vendor", which this plugin\'s row does not share: dsh-opencode-patch leaves the route opencode to pi-ai'
    );
    expect(
      stepAsideMessage("opencode-go", { kind: "realm", realm: true }, "row")
    ).toContain(
      'the pi-ai row "row" resolves credentials in a realm private to it'
    );
    expect(stepAsideMessage("opencode", { kind: "realm" }, "llm-pi-ai")).toBe(
      'the pi-ai row "llm-pi-ai" resolves credentials in a realm it inherits from an enclosing group, which this plugin\'s row does not share: dsh-opencode-patch leaves the route opencode to pi-ai'
    );
    expect(
      stepAsideMessage(
        "opencode-go",
        { header: "X-OpenCode-Plugin", kind: "marker" },
        "llm-pi-ai"
      )
    ).toBe(
      'its entry carries the "X-OpenCode-Plugin" header another plugin writes: dsh-opencode-patch leaves the route opencode-go to pi-ai'
    );
  });
});
