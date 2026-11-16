/**
 * `credentials.ts` — the capture store per root, and the fetch patch's one
 * resolver over it.
 *
 * The store is driven directly (filing, the three lookups, the route-only
 * lookup, L8's strikes, the drop and its lifting, one store per root), and the
 * resolver with an environment of the case's own (the capture gate, the fill
 * order per policy, the report of what was consulted, the settle).
 *
 * @module test/credentials.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpencodeStore } from "./support/opencode-store-fixture.ts";
import {
  captureStoreFor,
  createCaptureStore,
  createCredentials,
  type KeySourcePolicy,
  resolveOpencodeStoreKey,
} from "./support/src.ts";

const GO = "https://opencode.ai/zen/go/v1/chat/completions";
const ZEN = "https://opencode.ai/zen/v1/chat/completions";
const RELAY = "https://relay.example/v1/chat/completions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("credentials · the capture store", () => {
  it("files a key by route and plane, and answers the three lookups", () => {
    const store = createCaptureStore();
    store.record("go-k", "opencode-go", GO);
    store.record("zen-k", "opencode", ZEN);
    expect(store.get("opencode-go", "go")).toBe("go-k");
    expect(store.get(undefined, "go")).toBe("go-k");
    expect(store.get(undefined, "zen")).toBe("zen-k");
    // The latest key, with no tier asked.
    expect(store.get()).toBe("zen-k");
    // A route-scoped hit is filtered by the tier asked.
    expect(store.get("opencode", "go")).toBe("go-k");
    expect(store.get("nobody")).toBe("zen-k");
  });

  it("ignores a blank or placeholder key, and trims a real one", () => {
    const store = createCaptureStore();
    store.record("  ", "opencode-go", GO);
    store.record("unused", "opencode-go", GO);
    expect(store.get(undefined, "go")).toBeUndefined();
    store.record(" go-k ", "", GO);
    expect(store.get(undefined, "go")).toBe("go-k");
    // An empty route files nothing by route.
    expect(store.forRoute("")).toBeUndefined();
  });

  it("answers a route's own key on neither plane, and only that (OC3)", () => {
    const store = createCaptureStore();
    store.record("go-k", "my-relay", GO);
    expect(store.forRoute("my-relay")).toBeUndefined();
    store.record("relay-k", "my-relay", RELAY);
    expect(store.forRoute("my-relay")).toBe("relay-k");
    expect(store.forRoute("other")).toBeUndefined();
    // The plane's own key still answers its plane, with the relay's beside it.
    expect(store.get(undefined, "go")).toBe("go-k");
  });

  it("OC3 — a key sent to a URL on neither plane answers no plane lookup, by route, by tier or as the latest", () => {
    const store = createCaptureStore();
    store.record("relay-k", "my-relay", RELAY);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get(undefined, "zen")).toBeUndefined();
    expect(store.get("my-relay", "go")).toBeUndefined();
    // The known answers: its route's own lookup, and an untiered one.
    expect(store.forRoute("my-relay")).toBe("relay-k");
    expect(store.get("my-relay")).toBe("relay-k");
    expect(store.get()).toBe("relay-k");
  });

  it("a route named after a plane files its key under that plane even on a URL on neither plane (the name fallback, deliberate)", () => {
    // A plane route may carry its own baseURL; one that points off the
    // gateway is read as a mirror of the plane it is named after, so its key
    // is that plane's key in both directions. The OC3 relay rule is for a
    // route NOT named after a plane.
    const store = createCaptureStore();
    store.record("mirror-go", "opencode-go", RELAY);
    expect(store.get(undefined, "go")).toBe("mirror-go");
    expect(store.get(undefined, "zen")).toBeUndefined();
    expect(store.forRoute("opencode-go")).toBeUndefined();
    store.record("mirror-zen", "opencode", RELAY);
    expect(store.get(undefined, "zen")).toBe("mirror-zen");
  });

  it("OC3 / L8 — dropping a plane's key never lets a relay's key answer that plane", () => {
    const store = createCaptureStore();
    store.record("go-k", "opencode-go", GO);
    store.record("relay-k", "my-relay", RELAY);
    expect(store.get(undefined, "go")).toBe("go-k");
    store.settle("go-k", "opencode-go", GO, "refused", false);
    store.settle("go-k", "opencode-go", GO, "refused", false);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get("opencode-go", "go")).toBeUndefined();
    expect(store.forRoute("my-relay")).toBe("relay-k");
  });

  it("drops a key after a second refusal in a row on its plane, and lifts the drop on an acceptance", () => {
    const store = createCaptureStore();
    store.record("k", "opencode-go", GO);
    store.record("z", "opencode", ZEN);
    expect(store.settle("k", "opencode-go", GO, "refused", false)).toBe(false);
    expect(store.get(undefined, "go")).toBe("k");
    // An acceptance between clears the strike.
    store.settle("k", "opencode-go", GO, "accepted", false);
    store.settle("k", "opencode-go", GO, "refused", false);
    expect(store.get(undefined, "go")).toBe("k");
    store.settle("k", "opencode-go", GO, "refused", false);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get("opencode-go", "go")).toBeUndefined();
    // Per plane: the Zen key stands.
    expect(store.get(undefined, "zen")).toBe("z");
    // Dropped: not filed again, and a further refusal changes nothing…
    store.record("k", "opencode-go", GO);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.settle("k", "opencode-go", GO, "refused", false)).toBe(false);
    // …and an acceptance of a request that may not file it (a key the fill
    // supplied) leaves the drop where it is…
    expect(store.settle("k", "opencode-go", GO, "accepted", false)).toBe(false);
    store.record("k", "opencode-go", GO);
    expect(store.get(undefined, "go")).toBeUndefined();
    // …until a request that carried it as its own is accepted.
    expect(store.settle("k", "opencode-go", GO, "accepted", true)).toBe(true);
    store.record("k", "opencode-go", GO);
    expect(store.get(undefined, "go")).toBe("k");
  });

  it("a strike counts against the key that drew it, not the next one", () => {
    const store = createCaptureStore();
    store.record("a", "opencode-go", GO);
    store.settle("a", "opencode-go", GO, "refused", false);
    store.record("b", "opencode-go", GO);
    store.settle("b", "opencode-go", GO, "refused", false);
    expect(store.get(undefined, "go")).toBe("b");
  });

  it("drops a relay key by its route, and leaves a key it never held alone", () => {
    const store = createCaptureStore();
    store.record("r", "my-relay", RELAY);
    expect(store.settle("never", "my-relay", RELAY, "refused", false)).toBe(
      false
    );
    store.settle("r", "my-relay", RELAY, "refused", false);
    store.settle("r", "my-relay", RELAY, "refused", false);
    expect(store.forRoute("my-relay")).toBeUndefined();
    expect(store.get()).toBeUndefined();
    // With no route at all, the scope is the route-less one.
    store.record("n", undefined, RELAY);
    expect(store.get()).toBe("n");
    store.settle("n", undefined, RELAY, "refused", false);
    store.settle("n", undefined, RELAY, "refused", false);
    expect(store.get()).toBeUndefined();
  });

  it("drops a key held only under its plane, with no route and not the latest", () => {
    const store = createCaptureStore();
    store.record("k", undefined, GO);
    store.record("z", "opencode", ZEN);
    store.settle("k", undefined, GO, "refused", false);
    store.settle("k", undefined, GO, "refused", false);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get(undefined, "zen")).toBe("z");
  });

  it("dropping a key leaves a route's entry for the other plane alone", () => {
    const store = createCaptureStore();
    store.record("k", "opencode-go", GO);
    store.record("k", "opencode", ZEN);
    store.settle("k", "opencode-go", GO, "refused", false);
    store.settle("k", "opencode-go", GO, "refused", false);
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(store.get("opencode", "zen")).toBe("k");
  });
});

describe("credentials · one store per root", () => {
  it("two roots never share a store; two contexts of one root do", async () => {
    const one = new Context();
    const two = new Context();
    captureStoreFor(one).record("k", "opencode-go", GO);
    expect(captureStoreFor(two).get(undefined, "go")).toBeUndefined();
    let child: unknown;
    const fiber = one.plugin(
      {
        apply: (ctx: unknown) => {
          child = ctx;
        },
        name: "child-of-one",
      } as never,
      {} as never
    );
    await fiber.await();
    expect(child).not.toBe(one);
    expect(captureStoreFor(child).get(undefined, "go")).toBe("k");
    await fiber.dispose();
  });

  it("a stand-in without a root keys on itself, and a non-object gets a store nobody else reads", () => {
    const standIn = {};
    captureStoreFor(standIn).record("k", "opencode-go", GO);
    expect(captureStoreFor(standIn).get(undefined, "go")).toBe("k");
    expect(captureStoreFor({ root: standIn }).get(undefined, "go")).toBe("k");
    const throwing = {
      get root(): never {
        throw new Error("hostile");
      },
    };
    captureStoreFor(throwing).record("t", "opencode-go", GO);
    expect(captureStoreFor(throwing).get(undefined, "go")).toBe("t");
    captureStoreFor(null).record("x", "opencode-go", GO);
    expect(captureStoreFor(null).get(undefined, "go")).toBeUndefined();
  });
});

describe("credentials · the fill's resolver", () => {
  /** A resolver over a fresh store and an environment of the case's own. */
  const resolver = (
    keySource: KeySourcePolicy = "auto",
    env: Readonly<Record<string, string>> = {},
    readOpencodeStore = false,
    storeReader?: (plane: string) => string | undefined
  ) => {
    const store = createCaptureStore();
    const reads: string[] = [];
    return {
      credentials: createCredentials({
        environment: (name) => {
          reads.push(name);
          return env[name];
        },
        keySource,
        readOpencodeStore,
        store,
        ...(storeReader === undefined ? {} : { storeReader }),
      }),
      reads,
      store,
    };
  };

  it("observe: answers the request's own usable key, and records it only from a decorated turn of the plugin's", () => {
    const { credentials, store } = resolver();
    const headers = new Headers({ authorization: "Bearer seen" });
    const request = {
      decorated: true,
      foreign: false,
      headers,
      marked: false,
      provider: "opencode-go",
      url: GO,
    };
    expect(credentials.observe({ ...request, decorated: false })).toBe("seen");
    expect(credentials.observe({ ...request, foreign: true })).toBe("seen");
    expect(credentials.observe({ ...request, marked: true })).toBe("seen");
    expect(store.get(undefined, "go")).toBeUndefined();
    expect(credentials.observe(request)).toBe("seen");
    expect(store.get(undefined, "go")).toBe("seen");
    expect(
      credentials.observe({
        ...request,
        headers: new Headers({ authorization: "Bearer unused" }),
      })
    ).toBeUndefined();
  });

  it.each([
    ["auto", "request-k"],
    ["request", "request-k"],
    ["configured", "request-k"],
  ] as const)(
    "fill under %s: the request's own key first",
    (policy, expected) => {
      const { credentials, store } = resolver(policy, {
        OPENCODE_GO_API_KEY: "env-go",
      });
      store.record("captured-go", "opencode-go", GO);
      expect(
        credentials.fillKey({
          plane: "opencode-go",
          provider: "opencode-go",
          requestKey: "request-k",
          url: GO,
        })
      ).toMatchObject({ key: expected, source: "request" });
    }
  );

  it.each([
    ["auto", "captured-go", "captured"],
    ["request", "captured-go", "captured"],
    ["configured", "env-go", "declared"],
  ] as const)(
    "fill under %s: a captured key unless configured",
    (policy, key, source) => {
      const { credentials, store } = resolver(policy, {
        OPENCODE_GO_API_KEY: "env-go",
      });
      store.record("captured-go", "opencode-go", GO);
      expect(
        credentials.fillKey({
          plane: "opencode-go",
          provider: "opencode-go",
          url: GO,
        })
      ).toMatchObject({ key, source });
    }
  );

  it("fill: the declared variable is the plane's, or the Zen one off the planes", () => {
    const env = { OPENCODE_API_KEY: "env-zen", OPENCODE_GO_API_KEY: "env-go" };
    const { credentials } = resolver("auto", env);
    expect(credentials.fillKey({ plane: "opencode-go", url: GO }).key).toBe(
      "env-go"
    );
    expect(credentials.fillKey({ plane: "opencode", url: ZEN }).key).toBe(
      "env-zen"
    );
    expect(
      credentials.fillKey({ plane: "", provider: "opencode-go", url: RELAY })
        .key
    ).toBe("env-go");
    expect(
      credentials.fillKey({ plane: "", provider: "my-relay", url: RELAY }).key
    ).toBe("env-zen");
  });

  it("fill: a route named after a plane takes that plane's capture on a URL on neither plane (the name fallback)", () => {
    const { credentials, store } = resolver();
    store.record("go-k", "opencode-go", GO);
    expect(
      credentials.fillKey({ plane: "", provider: "opencode-go", url: RELAY })
    ).toMatchObject({ key: "go-k", source: "captured" });
  });

  it("fill: a request on neither plane takes only its own route's key", () => {
    const { credentials, store } = resolver();
    store.record("go-k", "opencode-go", GO);
    expect(
      credentials.fillKey({ plane: "", provider: "my-relay", url: RELAY }).key
    ).toBeUndefined();
    expect(credentials.fillKey({ plane: "", url: RELAY }).key).toBeUndefined();
    store.record("relay-k", "my-relay", RELAY);
    expect(
      credentials.fillKey({ plane: "", provider: "my-relay", url: RELAY })
    ).toMatchObject({ key: "relay-k", source: "captured" });
  });

  it("fill: the real installation store answers last, and only when opted in", () => {
    const fixture = createOpencodeStore([
      { integrationId: "opencode-go", value: "store-go" },
    ]);
    vi.stubEnv("XDG_DATA_HOME", fixture.root);
    try {
      // The real store, by default.
      const off = resolver("auto", {}, false);
      expect(
        off.credentials.fillKey({ plane: "opencode-go", url: GO }).key
      ).toBe(undefined);
      const on = resolver("auto", {}, true);
      expect(
        on.credentials.fillKey({ plane: "opencode-go", url: GO })
      ).toMatchObject({ key: "store-go", source: "store" });
      const declared = resolver("auto", { OPENCODE_GO_API_KEY: "env" }, true);
      expect(
        declared.credentials.fillKey({ plane: "opencode-go", url: GO }).key
      ).toBe("env");
      expect(resolveOpencodeStoreKey("", true)).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("fill: the store is never read when an earlier step answers or the deployment did not opt in, and read once when it is reached", () => {
    const planes: string[] = [];
    const reader = (plane: string): string => {
      planes.push(plane);
      return "store-go";
    };
    const fill = (
      env: Readonly<Record<string, string>>,
      readOpencodeStore: boolean,
      requestKey?: string,
      seed?: string
    ) => {
      const { credentials, store } = resolver(
        "auto",
        env,
        readOpencodeStore,
        reader
      );
      if (seed !== undefined) {
        store.record(seed, "opencode-go", GO);
      }
      return credentials.fillKey({
        plane: "opencode-go",
        provider: "opencode-go",
        ...(requestKey === undefined ? {} : { requestKey }),
        url: GO,
      });
    };
    // Opted out: never read, though nothing else answers.
    expect(fill({}, false).key).toBeUndefined();
    // Each earlier step answering: never read.
    expect(fill({}, true, "own").source).toBe("request");
    expect(fill({}, true, undefined, "seen").source).toBe("captured");
    expect(fill({ OPENCODE_GO_API_KEY: "env" }, true).source).toBe("declared");
    expect(planes).toEqual([]);
    // Reached: read once, for the request's plane.
    expect(fill({}, true)).toMatchObject({ key: "store-go", source: "store" });
    expect(planes).toEqual(["opencode-go"]);
  });

  it("fill: reports what it consulted, a placeholder variable as set", () => {
    const { credentials } = resolver("auto", { OPENCODE_API_KEY: "unused" });
    const decision = credentials.fillKey({ plane: "opencode", url: ZEN });
    expect(decision.key).toBeUndefined();
    expect(decision.source).toBeUndefined();
    expect(decision.consulted).toEqual({
      declaredName: "OPENCODE_API_KEY",
      declaredSet: true,
      storeRead: false,
    });
    const blank = resolver("auto", { OPENCODE_API_KEY: "" });
    expect(
      blank.credentials.fillKey({ plane: "opencode", url: ZEN }).consulted
        .declaredSet
    ).toBe(false);
  });

  it("settle: two well-formed 401s drop a captured key; a 2xx brings back one the request itself carried", () => {
    const { credentials, store } = resolver();
    store.record("k", "opencode-go", GO);
    const sent = {
      decorated: true,
      key: "k",
      provider: "opencode-go",
      recordable: false,
      sessionWellFormed: true,
      status: 401,
      url: GO,
    };
    credentials.settle(sent);
    credentials.settle(sent);
    expect(store.get(undefined, "go")).toBeUndefined();
    // Accepted on a request that carried it as its own: filed again.
    credentials.settle({ ...sent, recordable: true, status: 204 });
    expect(store.get(undefined, "go")).toBe("k");

    // Accepted, but not the request's own key: the drop stays, and the
    // request's own observation does not file it either (OC3).
    const other = resolver();
    other.store.record("k", "opencode-go", GO);
    other.credentials.settle(sent);
    other.credentials.settle(sent);
    other.credentials.settle({ ...sent, status: 200 });
    expect(other.store.get(undefined, "go")).toBeUndefined();
    other.store.record("k", "opencode-go", GO);
    expect(other.store.get(undefined, "go")).toBeUndefined();
  });

  it("settle: a request outside any decorated turn neither strikes a key nor lifts a drop (OC3)", () => {
    const { credentials, store } = resolver();
    store.record("k", "opencode-go", GO);
    const turnless = {
      decorated: false,
      key: "k",
      provider: undefined,
      recordable: false,
      sessionWellFormed: true,
      status: 401,
      url: "https://opencode.ai/zen/go/v1/usage",
    };
    credentials.settle(turnless);
    credentials.settle(turnless);
    credentials.settle(turnless);
    expect(store.get(undefined, "go")).toBe("k");
    // The known answer: the same two refusals on a decorated turn drop it…
    const decorated = { ...turnless, decorated: true, provider: "opencode-go" };
    credentials.settle(decorated);
    credentials.settle(decorated);
    expect(store.get(undefined, "go")).toBeUndefined();
    // …and a turnless acceptance does not lift the drop.
    credentials.settle({ ...turnless, status: 200 });
    store.record("k", "opencode-go", GO);
    expect(store.get(undefined, "go")).toBeUndefined();
  });

  it("settle: a 401 on a malformed session, another status, or no key says nothing about the key", () => {
    const { credentials, store } = resolver();
    store.record("k", "opencode-go", GO);
    const sent = {
      decorated: true,
      key: "k",
      provider: "opencode-go",
      recordable: false,
      sessionWellFormed: false,
      status: 401,
      url: GO,
    };
    credentials.settle(sent);
    credentials.settle(sent);
    credentials.settle({ ...sent, sessionWellFormed: true, status: 403 });
    credentials.settle({ ...sent, sessionWellFormed: true, status: 500 });
    credentials.settle({ ...sent, key: undefined, sessionWellFormed: true });
    credentials.settle({ ...sent, key: "unused", sessionWellFormed: true });
    expect(store.get(undefined, "go")).toBe("k");
    // The known answer: the same two 401s on a well-formed session drop it.
    credentials.settle({ ...sent, sessionWellFormed: true });
    credentials.settle({ ...sent, sessionWellFormed: true });
    expect(store.get(undefined, "go")).toBeUndefined();
  });

  it("sessionPin: the deployment's pinned id, read from its environment", () => {
    const { credentials, reads } = resolver("auto", { PIN: "ses_pinned" });
    expect(credentials.sessionPin(undefined)).toBeUndefined();
    expect(credentials.sessionPin("")).toBeUndefined();
    expect(credentials.sessionPin("PIN")).toBe("ses_pinned");
    expect(reads).toEqual(["PIN"]);
  });

  it("reads the process environment when no environment is handed in", () => {
    vi.stubEnv("OPENCODE_GO_API_KEY", "process-go");
    const credentials = createCredentials({
      keySource: "auto",
      readOpencodeStore: false,
      store: createCaptureStore(),
    });
    expect(credentials.fillKey({ plane: "opencode-go", url: GO }).key).toBe(
      "process-go"
    );
  });
});
