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
 * the gap. Since P9 both halves are built from one list, `REMOTE_CONTRACTS`: the
 * client's descriptors are its descriptors, and the plugin, mounted on a real
 * cordis `Context`, must answer every contract with a service carrying exactly
 * its methods, and mount nothing else. It used to grep `src/` for the services;
 * it reads the contracts and the mounted services now.
 *
 * @module test/remote-contract.test
 */
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { disposeMounted, mountPlugin, until } from "./support/composition.ts";
import {
  GoUsageService,
  ModelPurgeService,
  OpencodeStoreService,
  parseAccountRef,
  parsePurgeResult,
  parseStoreInspection,
  parseUsageQuery,
  parseUsageReading,
  patchRemote,
  REMOTE_CONTRACTS,
  usageRemote,
} from "./support/src.ts";

/** The prototype key `remoteMethods()` reads, as the services spell it. */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

afterEach(async () => {
  await disposeMounted();
});

/** The service the composition resolves for a namespace, if any. */
const serviceOn = (
  ctx: { get: (name: never) => unknown },
  namespace: string
): Record<string, unknown> | undefined => {
  const service: unknown = ctx.get(namespace as never);
  return typeof service === "object" && service !== null
    ? (service as Record<string, unknown>)
    : undefined;
};

describe("remote contract · host and client agree", () => {
  it("lists the three contracts, so the checks below are not vacuous", () => {
    expect(REMOTE_CONTRACTS.map((contract) => contract.namespace)).toEqual([
      "opencodeGoUsage",
      "opencodeModelPurge",
      "opencodeStore",
    ]);
  });

  it("registers exactly the contracts' descriptors on the client", () => {
    const expected = REMOTE_CONTRACTS.flatMap(
      (contract) => contract.descriptors
    );
    expect(patchRemote.descriptors).toEqual(expected);
    for (const [index, descriptor] of patchRemote.descriptors.entries()) {
      // The contract's own object, not a copy that could drift from it.
      expect(descriptor).toBe(expected[index]);
    }
    expect(patchRemote.package).toBe("dsh-opencode-patch");
  });

  it("mounts a service for every contract, carrying exactly its methods, each one it can answer", async () => {
    // Per method, not per namespace: a namespace with one descriptor and a
    // second declared method would pass a namespace check and still leave the
    // second unreachable. Read through the host's own `remoteMethods()`.
    const { ctx } = await mountPlugin({ config: { usageEnabled: true } });
    for (const contract of REMOTE_CONTRACTS) {
      await until(
        () => serviceOn(ctx, contract.namespace) !== undefined,
        `ctx.get('${contract.namespace}')`
      );
      const service = serviceOn(ctx, contract.namespace);
      expect(
        (service?.typertRemote as { namespace?: unknown } | undefined)
          ?.namespace,
        contract.namespace
      ).toBe(contract.namespace);
      expect(
        remoteMethods(service as never).map(({ method }) => method),
        contract.namespace
      ).toEqual(Object.keys(contract.methods));
      // The marker is written FROM the contract, so the list above is equal by
      // construction; this is what says the service can answer each method,
      // should a cast defeat `markRemote`'s compile-time check.
      for (const method of Object.keys(contract.methods)) {
        expect(
          typeof service?.[method],
          `${contract.namespace}.${method}`
        ).toBe("function");
      }
    }
  });

  it("mounts no remote service outside the contracts", async () => {
    // A tripwire on the installer's own report, not a proof: every service
    // `installRemoteService` mounts says it "is reachable with a typertRemote
    // binding", once, and there must be exactly one such line per contract. A
    // reworded report fails this loudly; a service mounted some other way
    // would not be seen.
    const { lines } = await mountPlugin({ config: { usageEnabled: true } });
    const reachable = (): string[] =>
      lines().filter((line) =>
        /is reachable with a typertRemote binding/u.test(line)
      );
    await until(
      () => reachable().length >= REMOTE_CONTRACTS.length,
      "every remote service's report"
    );
    expect(reachable()).toHaveLength(REMOTE_CONTRACTS.length);
    for (const contract of REMOTE_CONTRACTS) {
      expect(
        reachable().filter((line) => line.includes(`${contract.namespace} is`))
      ).toHaveLength(1);
    }
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

  it("parses both usage reads' answers with the reading parser (D5), not the vendor whitelist", () => {
    // `parseGoUsage` drops `allowance`, `quotaUnavailable` and the session's
    // plane spend, which the service attaches and the panel renders.
    expect(usageRemote.methods.read.result.schema.parse).toBe(
      parseUsageReading
    );
    expect(usageRemote.methods.readAccount.result.schema.parse).toBe(
      parseUsageReading
    );
  });

  it("gives every wire codec one parser, whichever door the runtime takes", () => {
    // A codec answers its parser twice: as `schema.parse`, and from `create()`.
    // A runtime that builds a fresh codec per call takes the second door, so a
    // codec whose two doors parse differently decodes one way in a test that
    // reads the schema and another on the host. Every parameter and result
    // codec the descriptors carry is checked, and the walk must see some.
    interface Codec {
      readonly create: () => { readonly parse: unknown };
      readonly schema: { readonly parse: unknown };
      readonly typeSymbol: string;
    }
    const codecs = new Set<Codec>();
    for (const descriptor of patchRemote.descriptors) {
      const { parameters = [], result } = descriptor as unknown as {
        parameters?: readonly { codec?: Codec }[];
        result?: Codec;
      };
      for (const codec of [result, ...parameters.map((p) => p.codec)]) {
        if (codec !== undefined) {
          codecs.add(codec);
        }
      }
    }
    expect(codecs.size).toBeGreaterThanOrEqual(5);
    for (const codec of codecs) {
      expect(codec.create().parse, codec.typeSymbol).toBe(codec.schema.parse);
      expect(codec.typeSymbol).toMatch(/^dsh-opencode-patch#/u);
    }
  });
});

/** One wire codec, as a descriptor carries it. */
interface WireCodec {
  readonly create: () => { readonly parse: unknown };
  readonly mode: string;
  readonly schema: { readonly parse: unknown };
  readonly typeSymbol: string;
}

/** One descriptor, read as plain data: the fields the pin below names. */
interface WireDescriptor {
  readonly id: string;
  readonly invocation: unknown;
  readonly method: string;
  readonly namespace: string;
  readonly parameters: readonly (Record<string, unknown> & {
    readonly codec: WireCodec;
  })[];
  readonly result: WireCodec;
  readonly service: string;
}

/** The client's descriptors, typed as the wire data they are. */
const wireDescriptors = (): readonly WireDescriptor[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the protocol types a descriptor's codecs opaquely; the pin reads them as the plain objects they are
  patchRemote.descriptors as unknown as readonly WireDescriptor[];

/** A descriptor as plain data, each codec replaced by its `typeSymbol`. */
const plain = (descriptor: WireDescriptor): Record<string, unknown> => ({
  ...descriptor,
  parameters: descriptor.parameters.map((parameter) => ({
    ...parameter,
    codec: parameter.codec.typeSymbol,
  })),
  result: descriptor.result.typeSymbol,
});

describe("remote contract · the wire, pinned field for field", () => {
  it("pins every descriptor field for field, so a rebuilt contract cannot drift", () => {
    // The descriptors are what the client's gateway mounts and validates
    // arity against, so a builder that derives them has to answer exactly
    // these: the same ids, the same one optional parameter, and no
    // `acceptsUndefined` key on a required one.
    const descriptors = wireDescriptors();
    expect(descriptors.map((descriptor) => plain(descriptor))).toEqual([
      {
        id: "dsh-opencode-patch#opencodeGoUsage/read",
        invocation: { kind: "direct" },
        method: "read",
        namespace: "opencodeGoUsage",
        parameters: [
          {
            acceptsUndefined: true,
            codec: "dsh-opencode-patch#UsageQuery",
            name: "query",
            source: "json",
            wire: "query",
          },
        ],
        result: "dsh-opencode-patch#GoUsage",
        service: "opencodeGoUsage",
      },
      {
        id: "dsh-opencode-patch#opencodeGoUsage/readAccount",
        invocation: { kind: "direct" },
        method: "readAccount",
        namespace: "opencodeGoUsage",
        parameters: [
          {
            codec: "dsh-opencode-patch#AccountRef",
            name: "ref",
            source: "json",
            wire: "ref",
          },
        ],
        result: "dsh-opencode-patch#GoUsage",
        service: "opencodeGoUsage",
      },
      {
        id: "dsh-opencode-patch#opencodeModelPurge/purge",
        invocation: { kind: "direct" },
        method: "purge",
        namespace: "opencodeModelPurge",
        parameters: [],
        result: "dsh-opencode-patch#PurgeResult",
        service: "opencodeModelPurge",
      },
      {
        id: "dsh-opencode-patch#opencodeStore/inspect",
        invocation: { kind: "direct" },
        method: "inspect",
        namespace: "opencodeStore",
        parameters: [],
        result: "dsh-opencode-patch#OpencodeStoreInspection",
        service: "opencodeStore",
      },
    ]);

    // Exact key sets: `toEqual` ignores an `undefined`-valued key, and a
    // present `acceptsUndefined: undefined` is not the absent key.
    for (const descriptor of descriptors) {
      expect(Object.keys(descriptor).toSorted()).toEqual([
        "id",
        "invocation",
        "method",
        "namespace",
        "parameters",
        "result",
        "service",
      ]);
      const codecs = [
        descriptor.result,
        ...descriptor.parameters.map((parameter) => parameter.codec),
      ];
      for (const codec of codecs) {
        expect(Object.keys(codec).toSorted()).toEqual([
          "create",
          "mode",
          "schema",
          "typeSymbol",
        ]);
        expect(codec.mode).toBe("strict");
      }
    }
    const [read, readAccount, purge, inspect] = descriptors;
    expect(Object.keys(readAccount?.parameters[0] ?? {}).toSorted()).toEqual([
      "codec",
      "name",
      "source",
      "wire",
    ]);

    // One result codec for both usage reads, and each other parser is the
    // contract's own. (The usage RESULT parser's identity is not pinned: P9
    // swaps it for the reading parser, which the wire never runs.)
    expect(read?.result).toBe(readAccount?.result);
    expect(read?.parameters[0]?.codec.schema.parse).toBe(parseUsageQuery);
    expect(readAccount?.parameters[0]?.codec.schema.parse).toBe(
      parseAccountRef
    );
    expect(purge?.result.schema.parse).toBe(parsePurgeResult);
    expect(inspect?.result.schema.parse).toBe(parseStoreInspection);
  });

  it.each([
    { methods: ["read", "readAccount"], Service: GoUsageService },
    { methods: ["purge"], Service: ModelPurgeService },
    { methods: ["inspect"], Service: OpencodeStoreService },
  ])(
    "pins the Remote marker $Service.name carries, as the host's reader sees it",
    ({ methods, Service }) => {
      // The marker `remoteMethods()` reads off the prototype, as `@Remote()`
      // would write it: non-enumerable, read-only, frozen, version 1.
      const descriptor = Reflect.getOwnPropertyDescriptor(
        Service.prototype,
        REMOTE_METHOD_DESCRIPTOR_KEY
      );
      expect(descriptor).toMatchObject({
        configurable: true,
        enumerable: false,
        writable: false,
      });
      const value: unknown = descriptor?.value;
      expect(value).toEqual({
        version: 1,
        methods: methods.map((method) => ({
          method,
          invocation: { kind: "direct" },
        })),
      });
      expect(Object.keys(value as object)).toEqual(["version", "methods"]);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen((value as { methods: unknown }).methods)).toBe(
        true
      );
    }
  );
});
