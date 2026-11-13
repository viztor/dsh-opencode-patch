/**
 * Loader rows and credential services, shaped the way `go-discovery.ts` reads
 * them, served on a real cordis `Context`.
 *
 * The rows are what a test means; the context they are served on is the one a
 * deployment has. `loaderOfContext` asks `ctx.get("loader")` first and reads
 * the `loader` property only as a fallback, which a real plugin context never
 * takes (property access without `inject` throws), so each helper provides
 * `loader` (and `credentials`) on `new Context()` and the cases drive the arm
 * a real host takes. Shared by the `go-discovery*` files and the usage
 * service's (`usage-fixture.ts`). Deliberately malformed shapes (`{ loader:
 * null }`, a non-callable `entries`) stay literal in the files that pass them,
 * as direct inputs to the reader.
 *
 * @module test/support/loader-rows
 */
import { Context } from "@deepseek-ai/cordis";

/** The Zen plane, which discovery rewrites onto the Go plane. */
export const ZEN_BASE = "https://opencode.ai/zen/v1";
/** The Go plane every rewrite targets. */
export const GO_BASE = "https://opencode.ai/zen/go/v1";
/** A request URL that classifies its own tier as Go. */
export const GO_REQUEST = "https://opencode.ai/zen/go/v1/chat/completions";
/** A request URL that classifies its own tier as Zen. */
export const ZEN_REQUEST = "https://opencode.ai/zen/v1/messages";

/**
 * A real cordis context whose loader serves `entries`. One context per
 * service, since a cordis Service registers itself on the context it is built
 * on. The array is read on every call, so a case may push a row later.
 */
export const contextWithEntries = (entries: readonly unknown[]): Context => {
  const ctx = new Context();
  ctx.provide("loader" as never, { entries: () => entries } as never);
  return ctx;
};

/** A context serving no credentials service: a headless composition. */
export const composition = (entries: readonly unknown[] = []): Context =>
  contextWithEntries(entries);

/** One `llm-pi-ai` provider-registry entry carrying a single route row. */
export const registryEntry = (
  routeId: string,
  row: Record<string, unknown>
): unknown => ({
  options: { config: { providers: { [routeId]: row } } },
});

/** A registry entry declaring several routes at once, whatever shape each is. */
export const registry = (rows: Record<string, unknown>): unknown => ({
  options: { config: { providers: rows } },
});

/** A standalone entry (`id: opencode-go`) declaring its config inline. */
export const standaloneEntry = (options: Record<string, unknown>): unknown => ({
  options,
});

/** The context plus the references the credentials service was asked for. */
export interface CredentialProbe {
  /** Every `ref` the lookup passed to `resolve`, in call order. */
  asked: string[];
  context: Context;
}

/**
 * A context serving a credentials service over `store`, recording each lookup.
 *
 * The recording is the point: "which reference was asked for" is not observable
 * from the returned key alone whenever two candidates resolve to the same
 * value, and it is the only way to prove the Zen reference is never offered to
 * the Go endpoint.
 */
export const withCredentials = (
  store: Record<string, string>,
  entries: readonly unknown[] = []
): CredentialProbe => {
  const asked: string[] = [];
  const context = contextWithEntries(entries);
  context.provide(
    "credentials" as never,
    {
      resolve: (ref: string): Promise<{ value?: string }> => {
        asked.push(ref);
        const value = store[ref];
        return Promise.resolve(value === undefined ? {} : { value });
      },
    } as never
  );
  return { asked, context };
};
