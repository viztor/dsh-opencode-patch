/**
 * The engine guard the whole suite runs behind.
 *
 * Exercised with versions whose answer is known in both directions, so a guard
 * that silently passed everything would fail here rather than look healthy.
 *
 * @module test/node-engine.test
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import setup, { engineRefusal, floorMajorOf } from "./support/node-engine.ts";

describe("node-engine guard", () => {
  it("reads a single >= floor and nothing else", () => {
    expect(floorMajorOf(">=24")).toBe(24);
    expect(floorMajorOf(" >= 24.3.1 ")).toBe(24);
    expect(floorMajorOf("^24")).toBeUndefined();
    expect(floorMajorOf(">=24 <27")).toBeUndefined();
    expect(floorMajorOf(24)).toBeUndefined();
  });

  it("refuses a Node below the floor and names both versions", () => {
    const refusal = engineRefusal("22.22.0", ">=24");
    expect(refusal).toContain("22.22.0");
    expect(refusal).toContain(">=24");
  });

  it("admits the floor itself and anything above it", () => {
    expect(engineRefusal("24.0.0", ">=24")).toBeUndefined();
    expect(engineRefusal("26.12.1", ">=24")).toBeUndefined();
  });

  it("reports a range it cannot read instead of admitting it", () => {
    expect(engineRefusal("26.0.0", "^24")).toMatch(/cannot read/u);
  });

  it("guards against the package's real floor, which this process satisfies", () => {
    // The input is the actual package.json, so a guard pointed at the wrong file
    // or the wrong field fails here instead of admitting every run.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { engines: { node: string } };
    expect(floorMajorOf(pkg.engines.node)).toBeGreaterThanOrEqual(24);
    expect(() => {
      setup();
    }).not.toThrow();
  });

  it("names the Node CI runs in .node-version, at or above the floor", () => {
    const pinned = Number(
      readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()
    );
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    expect(engineRefusal(`${pinned}.0.0`, ">=24")).toBeUndefined();
    expect(ci).toContain(`node-version: ${pinned}`);
  });
});

describe("offline guard", () => {
  it("is installed, refuses a public host and admits loopback", async () => {
    const { hostOf, offlineFetch } = await import("./support/offline.ts");
    // Installed for this file, the way the config promises.
    expect(globalThis.fetch).toBe(offlineFetch);
    await expect(
      offlineFetch("https://models.opencode.ai/api.json")
    ).rejects.toThrow(
      /offline test suite: refused a request to models\.opencode\.ai/u
    );
    expect(hostOf(new URL("http://127.0.0.1:1/x"))).toBe("127.0.0.1");
    expect(hostOf(new Request("http://localhost/x"))).toBe("localhost");
    expect(hostOf("not a url")).toBe("");
  });
});
