/**
 * The contract builder: what `defineRemote` and `remoteValue` derive from a
 * namespace and its methods.
 *
 * `test/remote-contract.test.ts` pins the plugin's own three contracts field
 * for field; this file holds the builder to its rules on a probe contract, so
 * every branch it has is driven here.
 *
 * @module test/remote-define.test
 */
import { describe, expect, it } from "vitest";

import { defineRemote, REMOTE_PACKAGE, remoteValue } from "./support/src.ts";

const parseText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const parseCount = (value: unknown): number => {
  if (typeof value !== "number") {
    throw new TypeError("not a count");
  }
  return value;
};

const text = remoteValue("Text", parseText);
const count = remoteValue("Count", parseCount);

const probe = defineRemote("probeNamespace", {
  first: {
    parameters: [
      { name: "query", optional: true, value: text },
      { name: "limit", value: count },
    ],
    result: count,
  },
  second: { result: text },
});

describe("remoteValue", () => {
  it("names the type under the package and puts one parser behind both doors", () => {
    expect(text.typeSymbol).toBe("dsh-opencode-patch#Text");
    expect(text.mode).toBe("strict");
    expect(text.schema.parse).toBe(parseText);
    expect(text.create().parse).toBe(parseText);
    expect(Object.keys(text).toSorted()).toEqual([
      "create",
      "mode",
      "schema",
      "typeSymbol",
    ]);
  });

  it("answers a fresh codec per call", () => {
    expect(remoteValue("Text", parseText)).not.toBe(text);
  });
});

describe("defineRemote", () => {
  it("derives one descriptor per method, in the order the methods are listed", () => {
    expect(probe.descriptors.map((descriptor) => descriptor.method)).toEqual([
      "first",
      "second",
    ]);
    for (const descriptor of probe.descriptors) {
      expect(descriptor.id).toBe(
        `dsh-opencode-patch#probeNamespace/${descriptor.method}`
      );
      expect(descriptor.namespace).toBe("probeNamespace");
      expect(descriptor.service).toBe("probeNamespace");
      expect(descriptor.invocation).toEqual({ kind: "direct" });
    }
  });

  it("marks only an optional parameter as accepting undefined, and wires each by its name", () => {
    const [first] = probe.descriptors;
    const [query, limit] = first?.parameters ?? [];
    expect(query).toEqual({
      acceptsUndefined: true,
      codec: text,
      name: "query",
      source: "json",
      wire: "query",
    });
    // No key at all, not `acceptsUndefined: undefined`.
    expect(Object.keys(limit ?? {}).toSorted()).toEqual([
      "codec",
      "name",
      "source",
      "wire",
    ]);
    expect(limit?.codec).toBe(count);
    expect(first?.result).toBe(count);
  });

  it("gives a method with no parameters an empty list", () => {
    const [, second] = probe.descriptors;
    expect(second?.parameters).toEqual([]);
    expect(second?.result).toBe(text);
  });

  it("keeps the namespace, the methods and the package beside the descriptors", () => {
    expect(probe.namespace).toBe("probeNamespace");
    expect(Object.keys(probe.methods)).toEqual(["first", "second"]);
    expect(probe.methods.second.result).toBe(text);
    expect(probe.package).toBe(REMOTE_PACKAGE);
    expect(REMOTE_PACKAGE).toBe("dsh-opencode-patch");
  });
});
