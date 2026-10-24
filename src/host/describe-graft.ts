/**
 * Settings keeps showing the planes (D18, F20).
 *
 * `settings.describe()` builds pi-ai's displayed `value` from pi-ai's RESOLVED
 * config, and the route claim keeps the two planes out of that, so on its own
 * the Settings page would read both planes as unconfigured — and
 * session-controller's `hasProviderApiKey`, which reads the same value, would
 * replace the user's default model after a Sign-in. One read-only wrapper puts
 * the committed plane entries back into pi-ai's descriptor. `base`, `user`
 * and the revision are left exactly as the host built them, and the user's
 * file is never written: the Models page edits it through `settings.mutate`.
 *
 * The gateway and `settings.write()` resolve `describe` per call, so an
 * instance wrapper is what every reader runs.
 *
 * @module dsh-opencode-patch/host/describe-graft
 */

import type { CordisContext } from "../cordis-context.ts";
import { isFunctionLike, isRecord } from "../utils/guards.ts";
import { PLANE_ROUTES, type PlaneRoute } from "../utils/protocols.ts";
import { patchMethod } from "./patch-method.ts";
import type { RouteClaim } from "./route-claim.ts";

/**
 * The descriptors with the missing plane entries grafted into one namespace's
 * `value.providers`. Pure: the input is never mutated, and every other
 * descriptor is handed back as it was.
 *
 * @param descriptors - what `settings.describe()` answered.
 * @param ns - pi-ai's settings namespace.
 * @param entries - the committed plane entries.
 * @returns the descriptors, the one changed by copy.
 */
export const graftPlaneEntries = (
  descriptors: unknown,
  ns: string,
  entries: Readonly<Partial<Record<PlaneRoute, unknown>>>
): unknown => {
  if (!Array.isArray(descriptors)) {
    return descriptors;
  }
  return descriptors.map((descriptor: unknown) => {
    if (
      !isRecord(descriptor) ||
      descriptor.ns !== ns ||
      !isRecord(descriptor.value)
    ) {
      return descriptor;
    }
    const providers = isRecord(descriptor.value.providers)
      ? descriptor.value.providers
      : {};
    const missing = PLANE_ROUTES.filter(
      (plane) =>
        Object.hasOwn(entries, plane) && !Object.hasOwn(providers, plane)
    );
    if (missing.length === 0) {
      return descriptor;
    }
    return {
      ...descriptor,
      value: {
        ...descriptor.value,
        providers: {
          ...providers,
          ...Object.fromEntries(
            missing.map((plane) => [plane, entries[plane]])
          ),
        },
      },
    };
  });
};

/**
 * Wrap `settings.describe` for as long as the settings service is mounted.
 *
 * @param ctx - the plugin context.
 * @param claim - the route claim whose committed entries are grafted.
 */
export const installDescribeGraft = (
  ctx: CordisContext,
  claim: Pick<RouteClaim, "committedEntries" | "piAiNamespace">
): void => {
  ctx.inject?.(["settings"], (scope: unknown) => {
    if (!isRecord(scope) || !isRecord(scope.settings)) {
      return;
    }
    const stop = patchMethod(
      scope.settings,
      "describe",
      (unpatched) =>
        function describe(this: unknown, ...args: unknown[]): unknown {
          return graftPlaneEntries(
            Reflect.apply(unpatched, this, args),
            claim.piAiNamespace(),
            claim.committedEntries()
          );
        },
      { id: "dsh-opencode-patch/settings-describe" }
    );
    if (isFunctionLike(scope.effect)) {
      Reflect.apply(scope.effect, scope, [
        () => () => stop?.(),
        "dsh-opencode-patch.describe-graft",
      ]);
    }
  });
};
