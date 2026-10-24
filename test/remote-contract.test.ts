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

/** Every `export const NAME = "value"` in `src/`, so a constant resolves. */
const exportedStrings = (): Map<string, string> => {
  const constants = new Map<string, string>();
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    for (const match of source.matchAll(
      /export const ([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/gu
    )) {
      if (match[1] !== undefined && match[2] !== undefined) {
        constants.set(match[1], match[2]);
      }
    }
  }
  return constants;
};

/** One remote service the host mounts: its file, class and namespace. */
interface HostService {
  readonly file: string;
  readonly className: string;
  readonly namespace: string;
}

/**
 * Every remote service the host mounts, with the namespace it mounts under.
 *
 * Read from the source rather than imported: the services publish their
 * namespace through `super(ctx, name)`, and instantiating them needs a cordis
 * context. The name may be a literal or an exported constant, and both resolve:
 * matching only the literal let `opencodeStore` — passed as `STORE_NAMESPACE` —
 * through with no client descriptor, and the card's inspection row could never
 * answer.
 */
const hostServices = (): HostService[] => {
  const constants = exportedStrings();
  const services: HostService[] = [];
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    const className = /export class (\w+) extends TypertRemoteService/u.exec(
      source
    )?.[1];
    const argument =
      /super\(\s*ctx\s+as\s+never\s*,\s*("([^"]+)"|[A-Z_][A-Z0-9_]*)\s*\)/u.exec(
        source
      );
    if (className === undefined || argument === null) {
      continue;
    }
    const namespace =
      argument[2] ??
      constants.get(argument[1] ?? "") ??
      `unresolved:${argument[1]}`;
    services.push({ className, file, namespace });
  }
  return services.toSorted((a, b) => a.namespace.localeCompare(b.namespace));
};

const hostNamespaces = (): string[] =>
  hostServices().map((service) => service.namespace);

/** The prototype key `remoteMethods()` reads, as the services spell it. */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

describe("remote contract · host and client agree", () => {
  it("finds the host namespaces, so the check is not vacuous", () => {
    // A grep that matches nothing is indistinguishable from a clean result;
    // these two are the services this plugin mounts today.
    expect(hostNamespaces()).toContain("opencodeGoUsage");
    expect(hostNamespaces()).toContain("opencodeModelPurge");
    expect(hostNamespaces()).toContain("opencodeStore");
    expect(
      hostNamespaces().filter((name) => name.startsWith("unresolved:"))
    ).toEqual([]);
  });

  it("registers a descriptor for every Remote METHOD each service declares", async () => {
    // Per method, not per namespace: a namespace with one descriptor and a
    // second declared method would pass the namespace check and still leave
    // the second unreachable.
    const declared = new Set(
      patchRemote.descriptors.map((d) => `${d.service}.${d.method}`)
    );
    const missing: string[] = [];
    let methods = 0;
    for (const service of hostServices()) {
      const module = (await import(join(SRC, service.file))) as Record<
        string,
        { prototype: Record<string, unknown> }
      >;
      const marker = module[service.className]?.prototype[
        REMOTE_METHOD_DESCRIPTOR_KEY
      ] as { methods?: readonly { method: string }[] } | undefined;
      for (const { method } of marker?.methods ?? []) {
        methods += 1;
        if (!declared.has(`${service.namespace}.${method}`)) {
          missing.push(`${service.namespace}.${method}`);
        }
      }
    }
    // Every service declares at least one method, so a marker read that found
    // nothing would show here rather than as a clean pass.
    expect(methods).toBeGreaterThanOrEqual(hostServices().length);
    expect(missing).toEqual([]);
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
});
