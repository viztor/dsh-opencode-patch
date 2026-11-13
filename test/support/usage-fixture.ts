/**
 * Fixtures for the `GoUsageService` files: the Go endpoint, a healthy payload,
 * a capturing `fetch` stub, the typed failure a read raises, and services
 * built on real cordis contexts — one context per service, since a cordis
 * Service registers itself on the context it is built on.
 *
 * @module test/support/usage-fixture
 */
import { Context } from "@deepseek-ai/cordis";
import { vi } from "vitest";

import { type Capture, urlOf } from "../test-helpers.ts";
import { contextWithEntries, registryEntry } from "./loader-rows.ts";
import { GoUsageService, isRecord } from "./src.ts";

/** The Go quota endpoint the composition uses unless something overrides it. */
export const GO_ENDPOINT = "https://opencode.ai/zen/go/v1";
/** The URL a read of {@link GO_ENDPOINT} must actually call. */
export const GO_USAGE_URL = `${GO_ENDPOINT}/usage`;

/** The wrapped `/usage` payload the gateway answers a healthy read with. */
export const okBody = (): string =>
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

/**
 * Point `globalThis.fetch` at a response factory and capture the request.
 *
 * A factory rather than one `Response`: a body can only be read once, and the
 * identity cases read the same service twice.
 */
export const stubFetch = (respond: () => Response): Capture => {
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
export interface UsageFailure {
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
export const failureOf = async (
  read: Promise<unknown>
): Promise<UsageFailure> => {
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

/** One `llm-pi-ai` provider-registry entry, shaped the way discovery reads it. */
export const providerEntry = (row: Record<string, unknown>): unknown =>
  registryEntry("opencode-go", row);

export { contextWithEntries };

/** A service pinned to one endpoint and one credential. */
export const serviceWithKey = (
  key: string,
  base: string = GO_ENDPOINT
): GoUsageService =>
  new GoUsageService(new Context(), {
    baseURL: () => base,
    resolveApiKey: () => Promise.resolve(key),
  });

/**
 * A service with no credential at all, resolved the way a cold profile does it:
 * no `resolveApiKey` escape hatch, nothing captured, nothing in the environment.
 */
export const serviceWithoutKey = (base: string = GO_ENDPOINT): GoUsageService =>
  new GoUsageService(new Context(), { baseURL: () => base });
