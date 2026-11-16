/**
 * `GoUsageService` — a read without a credential, and the read a silent meter
 * depends on.
 *
 * @module test/usage-service-credentials.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { disposeMounted, mountPlugin } from "./support/composition.ts";
import { withCredentials } from "./support/loader-rows.ts";
import {
  GoUsageService,
  clearSessionUsageStore,
  captureStoreFor,
} from "./support/src.ts";
import {
  contextWithEntries,
  failureOf,
  GO_ENDPOINT,
  GO_USAGE_URL,
  okBody,
  stubFetch,
} from "./support/usage-fixture.ts";
import { collectUnknown, headerOf, urlOf } from "./test-helpers.ts";

afterEach(async () => {
  await disposeMounted();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearSessionUsageStore();
});

describe("GoUsageService credential failures", () => {
  it("reports an unresolvable credential as a configuration state", async () => {
    // `configured: false` is the whole point: the client renders nothing at all
    // instead of an unavailable meter the user cannot act on.
    const missing = Object.assign(new Error("no Go key"), {
      code: "MISSING_CREDENTIAL",
    });
    const service = new GoUsageService(new Context(), {
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
      const service = new GoUsageService(new Context(), {
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
    // One composition per service, each having seen the same key on a Go
    // turn: the capture store is the root's, and a service is the root's too.
    const seen = (): Context => {
      const context = contextWithEntries([]);
      captureStoreFor(context).record(
        "sk-captured-key",
        "opencode-go",
        "https://opencode.ai/zen/go/v1/chat/completions"
      );
      return context;
    };
    const pinned = stubFetch(() => new Response(okBody()));
    await new GoUsageService(seen(), {
      keySource: "configured",
    }).read();
    expect(headerOf(pinned.init, "authorization")).toBe("Bearer sk-env-key");

    const rotated = stubFetch(() => new Response(okBody()));
    await new GoUsageService(seen(), {
      keySource: "request",
    }).read();
    expect(headerOf(rotated.init, "authorization")).toBe(
      "Bearer sk-captured-key"
    );
  });
});

describe("usage service: the read that a silent meter depends on", () => {
  /**
   * The whole path a working composition takes: the loader's rows name the Go
   * route, the route names the credential reference, the service resolves it and
   * reads the endpoint.
   *
   * It exists because "the meter shows nothing" is not evidence about which link
   * broke, and this asserts the links the SERVICE owns. A probe of the same path
   * against a real-shaped row and a real key answered with real window figures,
   * so a silent meter is a wiring question rather than a service one - and this
   * keeps that true.
   */
  const goRow = {
    options: {
      config: {
        providers: { "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" } },
      },
      name: "@deepseek-ai/dsh-llm-pi-ai",
    },
  };

  it("resolves its key and reads the endpoint", async () => {
    const respond = vi.fn(() =>
      Response.json({
        usage: {
          monthly: {
            percent: 44,
            resetsAt: "2026-11-01T00:00:00.000Z",
            status: "ok",
          },
          rolling: {
            percent: 0,
            resetsAt: "2026-10-12T07:20:40.000Z",
            status: "ok",
          },
          weekly: {
            percent: 0,
            resetsAt: "2026-10-19T00:00:00.000Z",
            status: "ok",
          },
        },
      })
    );
    const capture = stubFetch(respond);
    const { asked, context } = withCredentials(
      { OPENCODE_GO_API_KEY: "go-key" },
      [goRow]
    );

    const service = new GoUsageService(context, { keySource: "auto" });
    const usage = await service.read({ provider: "opencode-go" });

    // The route's own reference was offered first (order is the policy), the
    // endpoint was asked once with the Go key, and the figures came back.
    expect(asked[0]).toBe("OPENCODE_GO_API_KEY");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(capture.url).toBe(GO_USAGE_URL);
    expect(headerOf(capture.init, "authorization")).toBe("Bearer go-key");
    expect(usage.weekly.percent).toBe(0);
    expect(usage.monthly.percent).toBe(44);
    expect(usage.quotaUnavailable ?? false).toBe(false);
  });
});

const GO_CHAT = `${GO_ENDPOINT}/chat/completions`;

describe("the mounted meter and the capture store (P6: OC3, L8)", () => {
  /**
   * The meter the plugin mounts reads the key the fill learned on a decorated
   * turn of the same root, and its own `/usage` poll is no evidence about
   * that key: the usage endpoint refuses keys inference accepts, so its 401
   * never drops one (docs/credentials.md). Through the plugin as the Loader
   * mounts it, the meter as `ctx.get("opencodeGoUsage")` answers it, and the
   * patched `globalThis.fetch` the meter's own request goes through.
   */
  it("reads the key a decorated Go turn sent, and two refused polls leave it in place", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    vi.stubEnv("OPENCODE_GO_API_KEY", "");
    const sent: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        sent.push({
          authorization: new Headers(init?.headers).get("authorization"),
          url,
        });
        return Response.json(
          {},
          { status: url.endsWith("/usage") ? 401 : 200 }
        );
      })
    );
    const { ctx } = await mountPlugin({ config: { usageEnabled: true } });
    const goTurn = async (bearer: string): Promise<string | null> => {
      const downstream = async function* downstream() {
        await globalThis.fetch(GO_CHAT, {
          body: JSON.stringify({ model: "meter-model" }),
          headers: { authorization: `Bearer ${bearer}` },
          method: "POST",
        });
        yield { type: "finish" };
      };
      await collectUnknown(
        (
          ctx as unknown as {
            waterfall: (event: string, ...args: unknown[]) => unknown;
          }
        ).waterfall(
          "llm/stream",
          { provider: "opencode-go", sessionId: "meter" },
          downstream
        ) as AsyncIterable<unknown>
      );
      return sent.at(-1)?.authorization ?? null;
    };
    const usage = ctx.get("opencodeGoUsage" as never) as unknown as {
      read: () => Promise<unknown>;
    };
    // Nothing captured yet: the meter has no key and says so.
    await expect(usage.read()).rejects.toThrow(/not configured/u);
    expect(sent).toHaveLength(0);

    expect(await goTurn("sk-turn-go")).toBe("Bearer sk-turn-go");
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- the polls are sequential.
      await expect(usage.read()).rejects.toThrow();
      expect(sent.at(-1)).toEqual({
        authorization: "Bearer sk-turn-go",
        url: GO_USAGE_URL,
      });
    }
    // Two refused polls later, the key still fills a Go turn's placeholder,
    // and the meter still reads it.
    expect(await goTurn("unused")).toBe("Bearer sk-turn-go");
    await expect(usage.read()).rejects.toThrow();
    expect(sent.at(-1)?.authorization).toBe("Bearer sk-turn-go");
  });
});
