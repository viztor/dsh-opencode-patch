/**
 * Keep the unit and mock suites off the network.
 *
 * Both are documented as offline, and they were not: every `getLive*Catalog`
 * read on a stale catalog — which is every read in a fresh test process —
 * starts a background revalidation through `globalThis.fetch`. Measured: 54
 * requests to `models.opencode.ai` per unit run. Where the runner has network,
 * one that lands mid-test replaces the catalog under the case reading it, so
 * a result depended on what the vendor published that minute.
 *
 * A request to anything but loopback is refused here. The background refresh
 * already degrades to the bundled shim on a failed fetch, so nothing else
 * changes; a case that MEANS to fetch stubs `fetch` itself, and the mock suite
 * talks to a loopback server, which stays allowed. The e2e config leaves this
 * file out, because reaching the gateway is its whole point.
 *
 * @module test/support/offline
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The host a fetch input targets, or `""` when it is not an absolute URL. */
export const hostOf = (input: RequestInfo | URL): string => {
  let url: string;
  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    ({ url } = input);
  }
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const online = globalThis.fetch;

/** The guard, exported so a test can check it refuses what it should. */
export const offlineFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const host = hostOf(input);
  if (!LOOPBACK.has(host)) {
    throw new TypeError(
      `offline test suite: refused a request to ${host || "a non-URL input"}; stub fetch in the case that needs it`
    );
  }
  return online(input, init);
};

globalThis.fetch = offlineFetch as typeof fetch;
