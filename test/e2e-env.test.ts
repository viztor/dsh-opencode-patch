/**
 * The live suites' environment reader (`support/e2e-env.ts`), offline.
 *
 * `readE2eEnvironment` is the one place that decides whether a live suite runs
 * at all, whether the published-host binary e2e runs, and which key each plane
 * arms. A misread there is silent: a gate that reads the wrong variable skips
 * the whole suite green, and a swapped plane sends one plane's key to the
 * other's probes. Every case hands it an environment of its own, so nothing
 * here reads the process's.
 *
 * @module test/e2e-env.test
 */
import { describe, expect, it } from "vitest";

import { readE2eEnvironment } from "./support/e2e-env.ts";
import { KEYED_TIERS } from "./support/keyed-probes.ts";

/** Two keys no plane could confuse. */
const KEYS = {
  OPENCODE_API_KEY: "sk-zen-only",
  OPENCODE_GO_API_KEY: "sk-go-only",
} as const;

describe("readE2eEnvironment", () => {
  it.for([
    ["1", true],
    ["true", false],
    ["0", false],
    ["", false],
    [undefined, false],
  ] as const)("OPENCODE_E2E=%s runs the live suite: %s", ([value, live]) => {
    expect(readE2eEnvironment({ OPENCODE_E2E: value }).live).toBe(live);
  });

  it("maps each plane to its own key, for every tier and need", () => {
    for (const tier of KEYED_TIERS) {
      const env = readE2eEnvironment({ ...KEYS, OPENCODE_E2E_KEYED: tier });
      expect(env.tier).toBe(tier);
      for (const need of ["full", "probes"] as const) {
        const armed =
          tier === "full" || (tier === "probes" && need === "probes");
        expect(env.keyFor("opencode", need), `${tier}/${need}`).toBe(
          armed ? KEYS.OPENCODE_API_KEY : undefined
        );
        expect(env.keyFor("opencode-go", need), `${tier}/${need}`).toBe(
          armed ? KEYS.OPENCODE_GO_API_KEY : undefined
        );
      }
    }
  });

  it("arms nothing for a plane whose key is unset or blank", () => {
    const env = readE2eEnvironment({
      OPENCODE_API_KEY: "",
      OPENCODE_E2E_KEYED: "full",
    });
    expect(env.keyFor("opencode", "full")).toBeUndefined();
    expect(env.keyFor("opencode-go", "full")).toBeUndefined();
  });

  it("an unset tier is full, and one it does not know fails the read", () => {
    expect(readE2eEnvironment({}).tier).toBe("full");
    expect(() =>
      readE2eEnvironment({ OPENCODE_E2E_KEYED: "everything" })
    ).toThrow(/OPENCODE_E2E_KEYED must be one of/u);
  });

  it("a blank base URL is neither a mirror nor an override", () => {
    const blank = readE2eEnvironment({
      OPENCODE_GO_BASE_URL: "",
      OPENCODE_ZEN_BASE_URL: "",
    });
    expect(blank.mirrored).toBe(false);
    expect(blank.baseOverride).toEqual({});

    const zenOnly = readE2eEnvironment({
      OPENCODE_ZEN_BASE_URL: "https://mirror.example/zen/v1",
    });
    expect(zenOnly.mirrored).toBe(true);
    expect(zenOnly.baseOverride).toEqual({
      zen: "https://mirror.example/zen/v1",
    });
  });

  it("the binary e2e runs only on DSH_HOST_E2E=1, with the pinned cell by default", () => {
    const off = readE2eEnvironment({ DSH_HOST_E2E: "true" });
    expect(off.hostBinary).toEqual({
      cell: "pinned",
      enabled: false,
      path: "",
      prefix: "",
      probeCopy: "",
    });

    const on = readE2eEnvironment({
      DSH_HOST_E2E: "1",
      DSH_HOST_PI_CELL: "floating",
      DSH_HOST_PREFIX: "/opt/dsh",
      DSH_HOST_PROBE_COPY: "/opt/dsh/probe.json",
      PATH: "/opt/dsh/bin",
    });
    expect(on.hostBinary).toEqual({
      cell: "floating",
      enabled: true,
      path: "/opt/dsh/bin",
      prefix: "/opt/dsh",
      probeCopy: "/opt/dsh/probe.json",
    });
  });

  it("carries the record directory and the CI run a record links to", () => {
    const env = readE2eEnvironment({
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "42",
      GITHUB_SERVER_URL: "https://github.example",
      OPENCODE_E2E_RECORD_DIR: "records",
    });
    expect(env.recordDir).toBe("records");
    expect(env.run).toEqual({
      repository: "owner/repo",
      runId: "42",
      server: "https://github.example",
    });
    expect(readE2eEnvironment({}).recordDir).toBe("");
  });
});
