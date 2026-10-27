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
 * This file holds the service's construction, the endpoint it builds and the
 * identity it sends; its siblings hold credential failures
 * (`usage-service-credentials`), readings (`usage-service-readings`) and
 * gateway failures (`usage-service-failures`). Shared fixtures are
 * `support/usage-fixture.ts`.
 *
 * @module test/usage-service.test
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoUsageService,
  OPENCODE_PATCH_USER_AGENT,
  clearCapturedApiKeys,
  clearSessionUsageStore,
} from "./support/src.ts";
import {
  contextWithEntries,
  GO_ENDPOINT,
  GO_USAGE_URL,
  okBody,
  providerEntry,
  serviceWithKey,
  stubFetch,
} from "./support/usage-fixture.ts";
import { headerOf } from "./test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearCapturedApiKeys();
  clearSessionUsageStore();
});

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
    expect(new GoUsageService(new Context())).toBeInstanceOf(GoUsageService);
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

  it("rewrites the INFERENCE endpoint onto the Go plane too", async () => {
    // The case that was broken. The catalog now names the inference family for the
    // `opencode` provider (`api: https://opencode.ai/inference/openai/v1`), so a
    // base discovered from a provider row is very often that family — and the
    // rewrite handled only `zen/v1`. The meter then asked
    // `…/inference/openai/v1/usage`, which does not exist.
    //
    // Measured unauthenticated: `/zen/go/v1/usage` answers 401 (the route is there,
    // bring a credential) while both `/inference/openai/v1/usage` and
    // `/inference/go/openai/v1/usage` answer 404. So both families have to land on
    // the zen/go form.
    for (const declared of [
      "https://opencode.ai/inference/openai/v1",
      "https://opencode.ai/inference/v1",
      "https://opencode.ai/inference/go/openai/v1",
    ]) {
      const capture = stubFetch(() => new Response(okBody()));
      const service = new GoUsageService(
        contextWithEntries([providerEntry({ baseURL: declared })]),
        { resolveApiKey: () => Promise.resolve("sk-live-key") }
      );
      await service.read();
      expect(capture.url, declared).toBe(GO_USAGE_URL);
    }
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
      OPENCODE_PATCH_USER_AGENT
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
    const service = new GoUsageService(new Context(), {
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
    const service = new GoUsageService(new Context(), {
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
