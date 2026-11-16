/**
 * The plugin's one write to `globalThis.fetch`, and how it is undone.
 *
 * Activations of the plugin on one root nest their patches: each wraps
 * whatever `globalThis.fetch` is when its effect runs, which is the previous
 * activation's patch while that one is live. Undoing them in any order has to
 * end at the fetch that was there before the first, which a plain "restore
 * what I wrapped, if I am still current" cannot do: disposing the earlier
 * activation first skips its restore (it is not current), and the later one
 * then restores the earlier one's patch, which outlives both.
 *
 * So the installer keeps a chain of its links:
 *
 * - the original is read INSIDE the effect, so a fetch swapped between
 *   `apply` and the effect is the one wrapped;
 * - a link disposed while something sits on top of it stays in place as a
 *   pass-through (the patch reads its `live` flag first), so whatever wraps
 *   it still reaches the fetch underneath;
 * - a link disposed while it is current restores what it wrapped, and keeps
 *   unwinding while the function now in place is a disposed link of its own;
 * - a function the plugin did not install is never replaced or removed.
 *
 * @module dsh-opencode-patch/host/global-fetch
 */

import type { CordisContext } from "../cordis-context.ts";
import { isFetchFunction } from "../utils/guards.ts";

/** One installed patch: what it wrapped, and whether its activation is live. */
interface Link {
  readonly original: typeof fetch;
  readonly patched: typeof fetch;
  readonly activation: { live: boolean };
}

/** Every link not yet unwound, in install order. Module-level: one per process, as `globalThis` is. */
const chain: Link[] = [];

const UNAVAILABLE =
  "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session";

/**
 * Install one activation's fetch patch, restored on the activation's dispose.
 *
 * @param ctx - the activation's context; the patch lives in its effect.
 * @param build - wraps the fetch in place at effect time; `live` answers
 *   false once the activation is disposed, so a link left in the chain passes
 *   through.
 * @param announce - called once the patch is in place.
 * @returns `undefined` when there is no fetch to wrap (the caller then
 *   attaches nothing that needs one); otherwise whether `globalThis.fetch` is
 *   a live patch of the plugin's, this activation's own or one that wraps it
 *   (L1).
 */
export const installGlobalFetch = (
  ctx: CordisContext,
  build: (original: typeof fetch, live: () => boolean) => typeof fetch,
  announce: () => void
): (() => boolean) | undefined => {
  if (!isFetchFunction(globalThis.fetch)) {
    ctx.logger?.warn?.(UNAVAILABLE);
    return undefined;
  }
  ctx.effect?.(() => {
    const original: unknown = globalThis.fetch;
    if (!isFetchFunction(original)) {
      ctx.logger?.warn?.(UNAVAILABLE);
      return () => {
        // Nothing was installed, so there is nothing to restore.
      };
    }
    const activation = { live: true };
    const link: Link = {
      activation,
      original,
      patched: build(original, () => activation.live),
    };
    globalThis.fetch = link.patched;
    chain.push(link);
    announce();
    return () => {
      activation.live = false;
      if (globalThis.fetch !== link.patched) {
        // Something wraps this link: it stays, passing through, until the
        // function on top of it unwinds to it.
        return;
      }
      let current: Link | undefined = link;
      while (current !== undefined) {
        chain.splice(chain.indexOf(current), 1);
        globalThis.fetch = current.original;
        current = chain.find(
          (below) =>
            !below.activation.live && below.patched === globalThis.fetch
        );
      }
    };
  }, "dsh-opencode-patch.fetch-patch");
  return () =>
    chain.some(
      (link) => link.activation.live && link.patched === globalThis.fetch
    );
};
