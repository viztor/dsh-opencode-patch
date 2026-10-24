/**
 * The install under test is the host users run: pi at the harness's pin with
 * the harness's patch applied, and the `@deepseek-ai` cluster at the version
 * the published host resolves (`test/support/host-versions.ts`).
 *
 * The cases check the INSTALLED tree rather than the declarations alone: a pin
 * that `package.json` states but a stray range defeats would leave a second pi
 * in `node_modules`, and the suite would quietly test that one. What each reads:
 *
 * - the installed tree — the pi `loadHostPi` resolves and its identity with the
 *   root import, the `package.json` versions under `node_modules`, and the
 *   applied hunks in pi's `dist/`;
 * - pnpm's resolution record, `pnpm-lock.yaml` — the pi snapshot count and the
 *   patch hash pnpm recorded;
 * - the published ranges — this plugin's `peerDependencies` and the installed
 *   wrapper's own pi range, each checked against the versions installed.
 *
 * @module test/host-versions
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import semver from "semver";
import { describe, expect, it } from "vitest";

import { HOST_VERSIONS } from "./support/host-versions.ts";
import { loadHostPi } from "./support/src.ts";

const ROOT = join(import.meta.dirname, "..");

const versionOf = (dir: string): string => {
  const manifest = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8")
  ) as { version?: string };
  return manifest.version ?? "";
};

const installed = (name: string): string =>
  versionOf(join(ROOT, "node_modules", name));

/** The installed pi's package root, through the root symlink. */
const piRoot = (): string =>
  realpathSync(join(ROOT, "node_modules", "@earendil-works", "pi-ai"));

/** pnpm names a patch file after the version it patches. */
const PATCH = join(
  ROOT,
  "patches",
  `@earendil-works__pi-ai@${HOST_VERSIONS.pi}.patch`
);

/** The `patch_hash` the harness's own lockfile records for this patch. */
const HARNESS_PATCH_HASH =
  "66eaf960054f10441b93ac3857114e96c1901f6d183713e2f21437b007111644";

describe("host pin", () => {
  it("the pi the plane adapter loads at runtime is the harness's pin", async () => {
    // `loadHostPi` resolves the wrapper and walks up from its real location to
    // the first pi it finds — the copy the wrapper itself would load.
    const pi = await loadHostPi();
    expect(pi).toBeDefined();
    expect(pi?.version).toBe(HOST_VERSIONS.pi);
  });

  it("the root pi the tests import is that same copy, and the only one", async () => {
    // `loadHostPi` hands pi's function through untouched, so identity proves
    // one module instance — the tests and the plane adapter read one file.
    const pi = await loadHostPi();
    expect(pi?.getBuiltinModels).toBe(getBuiltinModels);
    expect(versionOf(piRoot())).toBe(HOST_VERSIONS.pi);
    // The link the wrapper's own lookup reaches (the walk `installedPiRoot`
    // takes from its real location) is the root's copy too.
    const wrapper = realpathSync(
      join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai")
    );
    expect(
      realpathSync(join(wrapper, "..", "..", "@earendil-works", "pi-ai"))
    ).toBe(piRoot());
    // And the lockfile records exactly one pi snapshot, the patched pin. This
    // reads what pnpm RESOLVED, not `node_modules/.pnpm`: pnpm keeps an
    // orphaned virtual-store directory until `modules-cache-max-age` (7 days)
    // expires, so a directory count would read a stale cache from a pre-pin
    // branch as a broken pin. A snapshot key also carries the peer suffix, so a
    // second 1.1.0 under a different peer context counts as a second copy.
    // Mutation check, run against a scratch copy of the manifests: dropping the
    // global `overrides` entry does NOT go red here, because pnpm resolves the
    // wrapper's `^1.1.0` to the version the exact root devDependency already
    // pins (a fresh resolve without a lockfile included). What does produce a
    // second copy is a dependent asking for another pi, e.g. the scoped override
    // `"@deepseek-ai/dsh-llm-pi-ai>@earendil-works/pi-ai": "1.4.0"`: the lockfile
    // then holds a 1.1.0 and a 1.4.0 snapshot, and the wrapper's sibling link
    // resolves to 1.4.0 while the root stays on 1.1.0 — this count, the link
    // check above and `loadHostPi`'s version all read the split.
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    const snapshots = lock.split("\nsnapshots:\n").at(-1) ?? "";
    const piSnapshots = [
      ...snapshots.matchAll(/^ {2}'@earendil-works\/pi-ai@([^']+)':/gmu),
    ].map((match) => match[1] ?? "");
    expect(piSnapshots).toHaveLength(1);
    expect(
      piSnapshots[0]?.startsWith(
        `${HOST_VERSIONS.pi}(patch_hash=${HARNESS_PATCH_HASH})`
      ),
      piSnapshots[0]
    ).toBe(true);
    const locked = new Set(
      [...lock.matchAll(/@earendil-works\/pi-ai@(\d+\.\d+\.\d+)/gu)].map(
        (match) => match[1]
      )
    );
    expect([...locked]).toEqual([HOST_VERSIONS.pi]);
  });

  it("the dsh cluster is pinned to the published host's cluster versions", () => {
    // Every `@deepseek-ai/dsh-*` this repo declares, read from the manifest so
    // a new cluster package is covered without editing this list. They share
    // the cluster's tag; the two client-bundle packages (dsh-client-store,
    // dsh-client-ui-primitives) are not installed by the published host, and
    // follow the tag its frontend was built against.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const cluster = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter((name) => name.startsWith("@deepseek-ai/dsh-"));
    expect(cluster.length).toBeGreaterThan(0);
    for (const name of cluster) {
      expect(installed(name), name).toBe(HOST_VERSIONS.dsh);
    }
    expect(installed("@deepseek-ai/cordis")).toBe(HOST_VERSIONS.cordis);
    expect(installed("@deepseek-ai/cordis-plugin-loader")).toBe(
      HOST_VERSIONS.loader
    );
    // The ranges this plugin publishes admit the host it is tested on: a bump
    // that moves the install outside a peer range would otherwise ship as an
    // install error on exactly the host users run.
    const peers = Object.entries(manifest.peerDependencies ?? {});
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, range] of peers) {
      const version = installed(name);
      expect(
        semver.satisfies(version, range),
        `${name}@${version} vs ${range}`
      ).toBe(true);
    }
    // The pi pin sits inside the wrapper's own range: a legal resolution of
    // what the wrapper declares, not a forced skew.
    const wrapper = JSON.parse(
      readFileSync(
        join(ROOT, "node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    // Either declaration kind, and one must exist: semver reads an empty range
    // as `*`, so a missing declaration would otherwise pass without a check.
    const range = {
      ...wrapper.peerDependencies,
      ...wrapper.dependencies,
    }["@earendil-works/pi-ai"];
    expect(
      range,
      "dsh-llm-pi-ai no longer declares @earendil-works/pi-ai (dependencies or peerDependencies)"
    ).toBeTruthy();
    expect(semver.satisfies(HOST_VERSIONS.pi, range ?? ""), range).toBe(true);
  });

  it("the harness's patch is committed verbatim, recorded by pnpm, and applied to the installed pi", () => {
    // Byte-for-byte the harness's file: its hash is the one the harness's own
    // lockfile records, so this is a copy, not a re-derivation.
    const patch = readFileSync(PATCH);
    expect(createHash("sha256").update(patch).digest("hex")).toBe(
      HARNESS_PATCH_HASH
    );
    const files = [
      ...patch.toString("utf8").matchAll(/^diff --git a\/(\S+)/gmu),
    ].map((match) => match[1]);
    expect(files).toEqual([
      "dist/api/anthropic-messages.js",
      "dist/api/bedrock-converse-stream.js",
      "dist/api/mistral-conversations.js",
      "dist/api/openai-completions.js",
      "dist/api/openai-responses-shared.js",
      "dist/api/pi-messages.js",
    ]);
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain(
      `'@earendil-works/pi-ai@${HOST_VERSIONS.pi}': ${HARNESS_PATCH_HASH}`
    );

    // Applied: each hunk deletes a streaming re-parse of a tool call's
    // arguments. Unpatched, pi-messages.js carries one beside this context
    // line, and anthropic-messages.js one right after its partial_json append.
    const messages = readFileSync(
      join(piRoot(), "dist/api/pi-messages.js"),
      "utf8"
    );
    expect(messages).toContain("toolJson.set(event.contentIndex, json);");
    expect(messages).not.toContain("parseStreamingJson(json)");
    const anthropic = readFileSync(
      join(piRoot(), "dist/api/anthropic-messages.js"),
      "utf8"
    );
    const anchor = anthropic.indexOf(
      "block.partialJson += event.delta.partial_json;"
    );
    expect(anchor).toBeGreaterThan(-1);
    expect(anthropic.slice(anchor, anchor + 160)).not.toContain(
      "parseStreamingJson"
    );
  });
});
