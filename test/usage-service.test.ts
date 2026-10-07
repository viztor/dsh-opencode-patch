/**
 * `GoUsageService` — the Host-side Go quota read and its Typert registration.
 *
 * `usage.test.ts` covers what surrounds this module: discovery, credential
 * precedence and the contract's parsers. This file is the service itself — the
 * endpoint it builds, the headers it sends, the reading it hands back, and every
 * typed failure the composer meter reacts to.
 *
 * Offline by construction: `fetch` is stubbed per case, the endpoint and the
 * credential are injected, and the two pieces of ambient state a read consults
 * (captured keys, session spend) are cleared after every case.
 *
 * @module test/usage-service.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoUsageService,
  clearCapturedApiKeys,
  clearSessionUsageStore,
  recordCapturedApiKey,
  recordTurnUsage,
  registerUsageRemotes,
  usageRemote,
} from "../src/index.ts";
import {
  createMockContext,
  headerOf,
  isRecord,
  type Capture,
} from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearCapturedApiKeys();
  clearSessionUsageStore();
});

/** The Go quota endpoint the composition uses unless something overrides it. */
const GO_ENDPOINT = "https://opencode.ai/zen/go/v1";
/** The URL a read of {@link GO_ENDPOINT} must actually call. */
const GO_USAGE_URL = `${GO_ENDPOINT}/usage`;

/** The wrapped `/usage` payload the gateway answers a healthy read with. */
const okBody = (): string =>
  JSON.stringify({
    usage: {
      monthly: {
        percent: 100,
        resetsAt: "2026-10-09T13:53:58.000Z",
        status: "rate-limited",
      },
      rolling: {
        percent: 15,
        resetsAt: "2026-10-01T16:55:56.004Z",
        status: "ok",
      },
      weekly: {
        percent: 42,
        resetsAt: "2026-10-05T00:00:00.000Z",
        status: "ok",
      },
    },
  });

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

/**
 * Point `globalThis.fetch` at a response factory and capture the request.
 *
 * A factory rather than one `Response`: a body can only be read once, and the
 * identity cases read the same service twice.
 */
const stubFetch = (respond: () => Response): Capture => {
  const capture: Capture = { init: undefined, url: "" };
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capture.url = urlOf(input);
      capture.init = init;
      return Promise.resolve(respond());
    }
  );
  return capture;
};

/** The fields of one quota read failure the meter branches on. */
interface UsageFailure {
  cause: unknown;
  code: unknown;
  details: Record<string, unknown>;
  message: unknown;
}

/**
 * The typed failure one read raised, proven by shape rather than cast.
 *
 * Everything the meter branches on lives in `code`/`details`, so asserting the
 * whole record also asserts what is *absent* — a non-configuration failure must
 * not carry `configured: false`, or the client hides a retryable meter.
 */
const failureOf = async (read: Promise<unknown>): Promise<UsageFailure> => {
  const caught: unknown = await read.catch((error: unknown) => error);
  if (!isRecord(caught) || !isRecord(caught.details)) {
    throw new Error(
      `expected a RemoteError carrying details, got ${String(caught)}`
    );
  }
  return {
    cause: caught.cause,
    code: caught.code,
    details: caught.details,
    message: caught.message,
  };
};

/** No-op disposer: the test process never unwinds a cordis tree. */
const disposeNothing = (): void => {
  // nothing to release outside a real cordis tree
};

/** One `llm-pi-ai` provider-registry entry, shaped the way discovery reads it. */
const providerEntry = (row: Record<string, unknown>): unknown => ({
  options: { config: { providers: { "opencode-go": row } } },
});

/**
 * A context satisfying both the cordis `Service` base and `discoverGoConfig`.
 *
 * `createMockContext` covers the first half only; the loader entries are what
 * make the discovery branches reachable.
 */
const contextWithEntries = (entries: readonly unknown[]): unknown => ({
  loader: { entries: () => entries },
  reflect: { provide: () => disposeNothing },
});

/** A service pinned to one endpoint and one credential. */
const serviceWithKey = (
  key: string,
  base: string = GO_ENDPOINT
): GoUsageService =>
  new GoUsageService(createMockContext(), {
    baseURL: () => base,
    resolveApiKey: () => Promise.resolve(key),
  });

/**
 * A service with no credential at all, resolved the way a cold profile does it:
 * no `resolveApiKey` escape hatch, nothing captured, nothing in the environment.
 */
const serviceWithoutKey = (base: string = GO_ENDPOINT): GoUsageService =>
  new GoUsageService(createMockContext(), { baseURL: () => base });

describe("GoUsageService construction", () => {
  it("refuses a context that is not an object before the Service base sees it", () => {
    // The service base registers itself on the context; a null/string/array
    // would fail there with a message that says nothing about the real cause.
    for (const bad of [null, undefined, "ctx", 42, []]) {
      expect(() => new GoUsageService(bad)).toThrow(
        "GoUsageService requires a Cordis context object"
      );
    }
    expect(() => new GoUsageService(null)).toThrow(TypeError);
    // A real object-shaped context is accepted.
    expect(new GoUsageService(createMockContext())).toBeInstanceOf(
      GoUsageService
    );
  });
});

describe("GoUsageService endpoint", () => {
  it("prefers the explicit endpoint and strips its trailing slash", async () => {
    // `usageBaseURL` is the one endpoint override a row may set, and a slash in
    // it would otherwise produce `…/v1//usage` — a 404 the meter reports as an
    // outage.
    const capture = stubFetch(() => new Response(okBody()));
    const service = new GoUsageService(
      contextWithEntries([
        providerEntry({ baseURL: "https://discovered.test/v1" }),
      ]),
      {
        baseURL: () => "https://explicit.test/v1/",
        resolveApiKey: () => Promise.resolve("sk-live-key"),
      }
    );

    await service.read();
    expect(capture.url).toBe("https://explicit.test/v1/usage");
  });

  it("rewrites a discovered Zen endpoint onto the Go plane", async () => {
    // A composition that only declares the pay-as-you-go route still meters Go:
    // the two planes share a host, so the Zen base addresses `/usage` once
    // rewritten. Reading the unrewritten base would 404 on every poll.
    const capture = stubFetch(() => new Response(okBody()));
    const service = new GoUsageService(
      contextWithEntries([
        providerEntry({ baseURL: "https://opencode.ai/zen/v1" }),
      ]),
      { resolveApiKey: () => Promise.resolve("sk-live-key") }
    );

    await service.read();
    expect(capture.url).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("falls back to the stock endpoint when nothing declares one", async () => {
    // A cold profile with no provider row still has to poll somewhere real.
    const capture = stubFetch(() => new Response(okBody()));
    await serviceWithKey("sk-live-key").read();
    expect(capture.url).toBe(GO_USAGE_URL);
  });

  it("sends the gateway's required headers and refuses to follow redirects", async () => {
    // These five headers are what the Go `/usage` endpoint requires; a dropped
    // one turns a healthy account into a 403 the meter reads as "no quota".
    const capture = stubFetch(() => new Response(okBody()));
    await serviceWithKey("sk-live-key").read();

    expect(headerOf(capture.init, "authorization")).toBe("Bearer sk-live-key");
    expect(headerOf(capture.init, "accept")).toBe("application/json");
    expect(headerOf(capture.init, "user-agent")).toBe(
      "opencode/1.18.33 dsh-opencode-patch"
    );
    expect(headerOf(capture.init, "x-opencode-client")).toBe("cli");
    expect(headerOf(capture.init, "x-opencode-project")).toBe("global");
    // A redirect must never be followed with a Go credential in the header.
    expect(capture.init?.redirect).toBe("error");
    expect(capture.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GoUsageService identity", () => {
  it("hands out one opaque account id per endpoint/credential pair", async () => {
    // The id is what the client uses to decide a reading still describes the
    // account it is drawing, so it must be stable across polls — and must not
    // be, or derive from, the credential.
    stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");

    const first = await service.read();
    const second = await service.read();
    expect(second.source).toBe(first.source);
    expect(first.source).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(first.source).not.toContain("sk-live-key");
  });

  it("regenerates the id when either half of the account changes", async () => {
    // Reusing the id across two accounts would make the client keep drawing a
    // stale meter instead of noticing the switch.
    stubFetch(() => new Response(okBody()));

    let base = "https://a.test/v1";
    const service = new GoUsageService(createMockContext(), {
      baseURL: () => base,
      resolveApiKey: () => Promise.resolve("sk-live-key"),
    });
    const first = await service.read();
    const repeated = await service.read();
    expect(repeated.source).toBe(first.source);
    base = "https://b.test/v1";
    const moved = await service.read();
    expect(moved.source).not.toBe(first.source);

    // The same holds for the credential reference: two references are two
    // accounts even when the endpoint is unchanged.
    const entries: unknown[] = [providerEntry({ apiKeyEnv: "GO_KEY_ONE" })];
    const keyed = new GoUsageService(contextWithEntries(entries), {
      baseURL: () => GO_ENDPOINT,
      resolveApiKey: () => Promise.resolve("sk-live-key"),
    });
    const keyedFirst = await keyed.read();
    entries.length = 0;
    entries.push(providerEntry({ apiKeyEnv: "GO_KEY_TWO" }));
    const rekeyed = await keyed.read();
    expect(rekeyed.source).not.toBe(keyedFirst.source);
  });

  it("forgets the account id when the credential cannot be resolved", async () => {
    // The credential service blipping must not leave the previous account's id
    // in place: the next successful poll would then look like the same account.
    stubFetch(() => new Response(okBody()));
    let failing = false;
    const service = new GoUsageService(createMockContext(), {
      baseURL: () => GO_ENDPOINT,
      resolveApiKey: (): Promise<string> =>
        failing
          ? Promise.reject(new Error("credentials service unreachable"))
          : Promise.resolve("sk-live-key"),
    });

    const first = await service.read();
    failing = true;
    await expect(service.read()).rejects.toThrow(
      "Could not resolve OpenCode Go API key"
    );
    failing = false;
    const recovered = await service.read();
    expect(recovered.source).not.toBe(first.source);
  });
});

describe("GoUsageService credential failures", () => {
  it("reports an unresolvable credential as a configuration state", async () => {
    // `configured: false` is the whole point: the client renders nothing at all
    // instead of an unavailable meter the user cannot act on.
    const missing = Object.assign(new Error("no Go key"), {
      code: "MISSING_CREDENTIAL",
    });
    const service = new GoUsageService(createMockContext(), {
      baseURL: () => GO_ENDPOINT,
      resolveApiKey: (): Promise<string> => Promise.reject(missing),
    });

    const failure = await failureOf(service.read());
    expect(failure.code).toBe("opencode-go/usage-unavailable");
    expect(failure.message).toBe("OpenCode Go API key is not configured");
    expect(failure.details).toEqual({
      configured: false,
      retainPrevious: false,
      retryable: false,
    });
  });

  it("keeps any other resolution failure visible and retryable", async () => {
    // A credentials service that throws is a fault, not a configuration: the
    // previous reading stays on screen and the poll retries. `configured` must
    // be absent, or the client would hide a meter that is merely broken.
    for (const cause of [
      new Error("credentials service unreachable"),
      Object.assign(new Error("vault sealed"), { code: "ENOLOCK" }),
    ]) {
      const service = new GoUsageService(createMockContext(), {
        baseURL: () => GO_ENDPOINT,
        resolveApiKey: (): Promise<string> => Promise.reject(cause),
      });
      const failure = await failureOf(service.read());
      expect(failure.message).toBe("Could not resolve OpenCode Go API key");
      expect(failure.details).toEqual({
        retainPrevious: false,
        retryable: true,
      });
    }
  });

  it("hands the configured keySource policy to credential resolution", async () => {
    // The policy is the user's choice between a rotated live key and a pinned
    // one; if the service ignored it, `request` setups would silently keep
    // polling with a stale credential.
    process.env.OPENCODE_GO_API_KEY = "sk-env-key";
    recordCapturedApiKey(
      "sk-captured-key",
      "opencode-go",
      "https://opencode.ai/zen/go/v1/chat/completions"
    );
    const context = contextWithEntries([]);

    const pinned = stubFetch(() => new Response(okBody()));
    await new GoUsageService(context, { keySource: "configured" }).read();
    expect(headerOf(pinned.init, "authorization")).toBe("Bearer sk-env-key");

    const rotated = stubFetch(() => new Response(okBody()));
    await new GoUsageService(context, { keySource: "request" }).read();
    expect(headerOf(rotated.init, "authorization")).toBe(
      "Bearer sk-captured-key"
    );
  });
});

describe("GoUsageService readings", () => {
  it("answers the zeroed Zen-overflow reading when only Zen is configured", async () => {
    // Go has no quota to report without a Go credential, so every window sits
    // at zero and the meter hands over to the Zen balance. The account id is
    // fresh per read here: there is no Go credential to key an identity on.
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    const service = serviceWithoutKey();

    const first = await service.read();
    const second = await service.read();
    expect(first.zenOverflow).toBe(true);
    expect(first.rolling.percent).toBe(0);
    expect(first.weekly.percent).toBe(0);
    expect(first.monthly.percent).toBe(0);
    expect(first.monthly.status).toBe("ok");
    // One reset instant for all three windows: a zeroed reading still has to
    // say when it resets, and the meter renders one countdown.
    expect(first.weekly.resetsAt).toBe(first.monthly.resetsAt);
    expect(first.source).toBeDefined();
    expect(second.source).not.toBe(first.source);
  });

  it("treats an explicit Zen route as overflow even with no Zen credit", async () => {
    // The client naming the Zen route is itself the signal that Go has nothing
    // to say, so the meter gets the zeroed reading instead of an error.
    const usage = await serviceWithoutKey().read({ provider: "opencode" });
    expect(usage.zenOverflow).toBe(true);
    expect(usage.rolling.percent).toBe(0);
    expect(usage.weekly.percent).toBe(0);
  });

  it("refuses to invent a reading when neither plane is configured", async () => {
    // An unconfigured account is the one case with no reading to show, so the
    // client is told so outright rather than handed a zeroed meter.
    const service = serviceWithKey("");
    const failure = await failureOf(service.read());
    expect(failure.message).toBe("OpenCode Go API key is not configured");
    expect(failure.details).toEqual({
      configured: false,
      retainPrevious: false,
      retryable: false,
    });
  });

  it("attaches the spend of the conversation that asked for it", async () => {
    // Spend is per conversation: two open sessions must not read the same total.
    recordTurnUsage(
      "session-a",
      { inputTokens: 1_000_000, totalTokens: 1_000_000 },
      { input: 1, output: 1 },
      "model-a"
    );
    recordTurnUsage(
      "session-b",
      { inputTokens: 2_000_000, totalTokens: 2_000_000 },
      { input: 1, output: 1 },
      "model-b"
    );
    stubFetch(() => new Response(okBody()));

    const a = await serviceWithKey("sk-live-key").read({
      sessionId: "session-a",
    });
    const b = await serviceWithKey("sk-live-key").read({
      sessionId: "session-b",
    });
    expect(a.session?.totalTokens).toBe(1_000_000);
    expect(a.session?.activeModel).toBe("model-a");
    expect(b.session?.totalTokens).toBe(2_000_000);
    expect(b.session?.activeModel).toBe("model-b");
  });

  it("falls back to the most recent conversation when the query names none", async () => {
    // A caller that knows no session still gets spend rather than an empty
    // figure — the Host can only offer the latest, so that is what it is.
    recordTurnUsage(
      "session-a",
      { inputTokens: 10, totalTokens: 10 },
      { input: 1, output: 1 },
      "model-a"
    );
    recordTurnUsage(
      "session-b",
      { inputTokens: 20, totalTokens: 20 },
      { input: 1, output: 1 },
      "model-b"
    );
    stubFetch(() => new Response(okBody()));

    const usage = await serviceWithKey("sk-live-key").read();
    expect(usage.session?.activeModel).toBe("model-b");
    expect(usage.session?.totalTokens).toBe(20);
  });

  it("omits session spend entirely when nothing has been recorded", async () => {
    // A meter that rendered "$0.00" against an empty store would be reporting a
    // lie; the key is simply absent.
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      sessionId: "none",
    });
    expect(Object.hasOwn(usage, "session")).toBe(false);
    expect(usage.monthly.percent).toBe(100);
  });

  it("marks a Go reading overflow-eligible exactly when Zen credit exists", async () => {
    // `zenOverflow` on a real reading is what tells the client the Go meters
    // may be backed by pay-as-you-go credit, so it must track Zen state and not
    // be hard-wired.
    stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");
    const withoutZen = await service.read();
    expect(withoutZen.zenOverflow).toBe(false);

    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    const withZen = await service.read();
    expect(withZen.zenOverflow).toBe(true);
  });
});

describe("GoUsageService gateway failures", () => {
  it("turns a 403 EntitlementError into the Zen-overflow reading", async () => {
    // The account overflowed onto Zen: Go refuses with `EntitlementError`, and
    // with Zen configured the right answer is the zeroed reading rather than an
    // outage. The account id carries over from the last healthy poll because it
    // is still the same account.
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? new Response(okBody())
        : new Response(
            '{"error":{"code":"EntitlementError","message":"no Go subscription"}}',
            { status: 403 }
          );
    });
    const service = serviceWithKey("sk-live-key");

    const before = await service.read();
    const after = await service.read();
    expect(after.zenOverflow).toBe(true);
    expect(after.rolling.percent).toBe(0);
    expect(after.weekly.percent).toBe(0);
    expect(after.monthly.percent).toBe(0);
    expect(after.source).toBe(before.source);
  });

  it("refuses an EntitlementError when there is no Zen credit to overflow into", async () => {
    // Without Zen the account simply has no Go plan, and the meter must say so
    // as an unconfigured state instead of drawing zeros forever.
    stubFetch(
      () =>
        new Response('{"error":{"code":"EntitlementError"}}', { status: 403 })
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe("OpenCode Go subscription required");
    expect(failure.details).toEqual({
      configured: false,
      retainPrevious: false,
      retryable: false,
    });
  });

  it("separates a transient HTTP status from a final one", async () => {
    // 408/429/5xx are worth retrying and must keep the last reading on screen;
    // 4xx means the request itself is wrong and retrying just hammers the
    // gateway with the same answer.
    const cases: [number, boolean][] = [
      [408, true],
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
      [404, false],
    ];
    for (const [status, transient] of cases) {
      stubFetch(() => new Response("upstream said no", { status }));
      const failure = await failureOf(serviceWithKey("sk-live-key").read());
      expect(failure.message).toBe(
        `OpenCode Go usage unavailable (HTTP ${status})`
      );
      expect(failure.details.retryable).toBe(transient);
      expect(failure.details.retainPrevious).toBe(transient);
      expect(typeof failure.details.source).toBe("string");
    }
  });

  it("rejects an oversized body before parsing it", async () => {
    // The cap exists because the body is read into memory first; rejecting
    // after `JSON.parse` would already have paid for the megabyte.
    stubFetch(() => new Response("x".repeat(1024 * 1024 + 1)));
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(
      `Response from ${GO_USAGE_URL} exceeds 1048576 byte limit`
    );
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(false);
  });

  it("surfaces a transport failure against the URL it could not read", async () => {
    // The meter shows the diagnostic verbatim, so the endpoint and the socket
    // error both have to survive into the message.
    vi.stubGlobal("fetch", (): Promise<Response> =>
      Promise.reject(new Error("ECONNRESET"))
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(`Could not read ${GO_USAGE_URL}: ECONNRESET`);
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(true);
  });

  it("reports malformed JSON as retryable", async () => {
    // A truncated body from a proxy is worth retrying; the previous reading
    // stays on screen meanwhile.
    stubFetch(() => new Response("<html>502 Bad Gateway</html>"));
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe("Invalid JSON in OpenCode Go usage response");
    expect(failure.details.retryable).toBe(true);
    expect(failure.details.retainPrevious).toBe(false);
  });

  it("reports a valid body of the wrong shape as a structure error", async () => {
    // The vendor changing the payload shape is the failure a hand-rolled stub
    // cannot catch, so the parse error must stay a real, retryable reading
    // rather than a crash — and its cause must survive in-process.
    stubFetch(() =>
      Response.json({
        usage: {
          rolling: {
            percent: 1,
            resetsAt: "2026-10-01T00:00:00.000Z",
            status: "ok",
          },
          weekly: {
            percent: 2,
            resetsAt: "2026-10-02T00:00:00.000Z",
            status: "ok",
          },
        },
      })
    );
    const failure = await failureOf(serviceWithKey("sk-live-key").read());
    expect(failure.message).toBe(
      "Invalid OpenCode Go usage response structure"
    );
    expect(failure.details.retryable).toBe(true);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.details.source).toBeDefined();
  });

  it("reads a healthy payload without a wrapper into the same reading", async () => {
    // The gateway has shipped both shapes; both must produce one reading, so a
    // wrapper-less body is not an outage.
    stubFetch(() =>
      Response.json({
        monthly: {
          percent: 3,
          resetsAt: "2026-10-09T00:00:00.000Z",
          status: "ok",
        },
        rolling: {
          percent: 4,
          resetsAt: "2026-10-01T00:00:00.000Z",
          status: "ok",
        },
        weekly: {
          percent: 5,
          resetsAt: "2026-10-05T00:00:00.000Z",
          status: "ok",
        },
      })
    );
    const usage = await serviceWithKey("sk-live-key").read();
    expect(usage.monthly.percent).toBe(3);
    expect(usage.rolling.percent).toBe(4);
    expect(usage.weekly.percent).toBe(5);
    expect(usage.monthly.status).toBe("ok");
  });
});

describe("registerUsageRemotes", () => {
  it("registers the quota remote under an injected typert scope", () => {
    // Without this registration the client has no `opencodeGoUsage.read` to
    // call, so the meter silently never mounts.
    const registered: Record<string, unknown>[] = [];
    const injected: string[][] = [];
    let pending: (() => void) | undefined;
    // `effect` lives on the PLUGIN context, not on the injected scope.
    // `typert` lives on the PLUGIN context too.
    const typert = {
      register: (contribution: Record<string, unknown>): void => {
        registered.push(contribution);
      },
    };
    const scope = {};

    registerUsageRemotes({
      effect: (fn: () => void): void => {
        pending = fn;
      },
      inject: (deps: string[], cb: (scoped: unknown) => void): void => {
        injected.push(deps);
        cb(scope);
      },
      typert,
    });

    expect(injected).toEqual([["typert"]]);
    // Registration belongs to the effect, not to the injection: a fiber that is
    // disposed before the effect runs must leave nothing behind.
    expect(registered).toEqual([]);
    pending?.();
    expect(registered.length).toBe(1);

    const [contribution] = registered;
    if (contribution === undefined) {
      throw new Error("expected one registered contribution");
    }
    expect(contribution.face).toBe("host");
    expect(contribution.package).toBe(usageRemote.package);
    // The invocations must BE the declared descriptors rather than a copy: a
    // divergent copy would answer calls under a stale shape.
    expect(contribution.invocations).toBe(usageRemote.descriptors);
    expect(contribution.model).toEqual({
      events: [],
      objects: [],
      services: [],
    });
    expect(contribution.schemas).toEqual([]);
  });

  it("returns without touching a context that serves no typert scope", () => {
    // A headless composition has no `inject` at all; the plugin must still load
    // and simply lose the remote face rather than throwing at mount time.
    expect(() => registerUsageRemotes({})).not.toThrow();
    expect(() => registerUsageRemotes(null)).not.toThrow();
  });

  it("survives an injected scope that is not a usable cordis scope", () => {
    // The scope arrives from another plugin, so a half-built one must not take
    // this plugin's own mount down with it.
    for (const scope of [null, "typert", 42, {}, { effect: "not-callable" }]) {
      expect(() =>
        registerUsageRemotes({
          inject: (_deps: string[], cb: (scoped: unknown) => void): void => {
            cb(scope);
          },
        })
      ).not.toThrow();
    }
  });

  it("runs the effect but registers nothing when typert offers no register", () => {
    // The effect still fires — so the code got as far as the typert lookup —
    // and the missing method is what stops the registration, rather than an
    // earlier guard that would have skipped the effect entirely.
    let effects = 0;
    let registered = 0;
    const scope = {
      typert: {
        register: (): void => {
          registered += 1;
        },
      },
    };

    const effect = (fn: () => void): void => {
      effects += 1;
      fn();
    };

    for (const typert of [null, {}, { register: "not-callable" }]) {
      registerUsageRemotes({
        effect,
        inject: (_deps: string[], cb: (scoped: unknown) => void): void => {
          cb({ ...scope, typert });
        },
      });
    }
    expect(effects).toBe(3);
    expect(registered).toBe(0);
  });
});
