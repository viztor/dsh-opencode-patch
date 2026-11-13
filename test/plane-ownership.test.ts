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
  credentialsRealmOf,
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
    expect([...steppedAsidePlanes(raw, "vendor")]).toEqual([
      ["opencode", { kind: "realm", realm: "vendor" }],
      ["opencode-go", { kind: "realm", realm: "vendor" }],
    ]);
    expect(takenPlanes(raw, "vendor")).toEqual([]);
  });

  it("takes every declared plane of a plain row (the known answer), and nothing of a config without planes", () => {
    const plainRow = { providers: { opencode: {}, "opencode-go": {} } };
    expect(steppedAsidePlanes(plainRow, undefined).size).toBe(0);
    expect(takenPlanes(plainRow, undefined)).toEqual([
      "opencode",
      "opencode-go",
    ]);
    for (const config of [undefined, null, {}, { providers: null }]) {
      expect(steppedAsidePlanes(config, "vendor").size).toBe(0);
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
