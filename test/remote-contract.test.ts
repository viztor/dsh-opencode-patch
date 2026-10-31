/**
 * The join between what the HOST mounts and what the CLIENT registers.
 *
 * This file exists because a featue shipped with both halves correct and the
 * pair disconnected: `opencodeModelPurge` was mounted on the host and called by
 * the card, but no remote contribution carried its descriptor — so the namespace
 * never reached the browser and the row reported "unavailable" for a host that
 * had the service all along.
 *
 * Neither half's own test could see it. `lifecycle.test.ts` asserted the SERVICE
 * mounted; `settings-page.test.tsx` asserted the contribution listed what it
 * listed. Both passed. The bug lived in the gap, so the assertion has to be about
 * the gap: every namespace a service is mounted under must appear in the
 * descriptors the client mounts, and nothing else may.
 *
 * @module test/remote-contract.test
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { patchRemote } from "../src/settings-page.tsx";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * Every namespace the host mounts a remote service under.
 *
 * Read from the source rather than imported: the services publish their
 * namespace through `super(ctx, "name")`, and instantiating them needs a cordis
 * context. A grep over the tree is the honest measurement of "what does the host
 * mount", and it fails loudly if the pattern ever changes.
 */
const hostNamespaces = (): string[] => {
  const found = new Set<string>();
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    for (const match of source.matchAll(
      /super\(\s*ctx\s+as\s+never\s*,\s*"([^"]+)"\s*\)/gu
    )) {
      if (match[1] !== undefined) {
        found.add(match[1]);
      }
    }
  }
  return [...found].toSorted();
};

describe("remote contract · host and client agree", () => {
  it("finds the host namespaces, so the check is not vacuous", () => {
    // A grep that matches nothing is indistinguishable from a clean result;
    // these two are the services this plugin mounts today.
    expect(hostNamespaces()).toContain("opencodeGoUsage");
    expect(hostNamespaces()).toContain("opencodeModelPurge");
  });

  it("registers a descriptor for every namespace the host mounts", () => {
    const mounted = new Set(
      patchRemote.descriptors.map((descriptor) => descriptor.service)
    );
    const missing = hostNamespaces().filter((name) => !mounted.has(name));
    expect(missing).toEqual([]);
  });

  it("registers nothing the host does not mount", () => {
    // The other direction: a descriptor for an unmounted service is a namespace
    // the browser can address and the host cannot answer.
    const host = new Set(hostNamespaces());
    const orphaned = [
      ...new Set(patchRemote.descriptors.map((d) => d.service)),
    ].filter((name) => !host.has(name));
    expect(orphaned).toEqual([]);
  });

  it("namespaces every descriptor uniquely and under one package", () => {
    const keys = patchRemote.descriptors.map((d) => d.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(patchRemote.package).toBe("dsh-opencode-patch");
  });

  it("publishes the account-scoped read the sibling account page calls", () => {
    // `dsh-opencode-go`'s account page reads usage through
    // `opencodeGoUsage.readAccount`; this plugin answers that namespace on the
    // root context, so the endpoint has to exist here or the page that owns the
    // account reports the namespace as unusable.
    const ids = patchRemote.descriptors.map((descriptor) => descriptor.id);
    expect(ids).toContain("dsh-opencode-patch#opencodeGoUsage/readAccount");
  });
});
