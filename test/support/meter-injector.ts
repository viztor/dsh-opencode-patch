/**
 * The meter's `readUsage` as the settings page's `apply` injects it, over a
 * stand-in context whose `opencodeGoUsage` remote answers through `read`.
 *
 * The stand-in is the least a context needs for `apply` to register the
 * meter's slot (`conversation.input.right`); the injector is then called for
 * a session, and the `readUsage` it hands the pill is returned. Shared by the
 * node file that pins the reader (`settings-page.test.tsx`) and the jsdom file
 * that mounts the pill over it (`usage-pill-mount.test.tsx`).
 *
 * `apply` is a parameter rather than an import: a jsdom file may not load the
 * test door, and this module imports nothing from `src`, so either side can
 * hand it the `apply` it already holds.
 *
 * @module test/support/meter-injector
 */

/** The reader the meter is handed. */
export type InjectedReadUsage<T = unknown> = (
  provider?: string,
  model?: string
) => Promise<T>;

/**
 * Applies the settings page over a stand-in context and returns the meter's
 * `readUsage`; throws when no injector registers, or it hands no reader.
 *
 * @param apply - the settings page's `apply`.
 * @param read - the remote's `read`, which the reader calls.
 */
export const injectedReadUsage = <T = unknown>(
  apply: (ctx: never) => unknown,
  read: () => Promise<unknown>
): InjectedReadUsage<T> => {
  let dockInjector: ((sessionId: unknown) => unknown) | undefined;
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    modelDirectories: { directoryFor: () => ({ store: {} }) },
    remote: { opencodeGoUsage: { read } },
    slots: {
      inject: (_name: string, fn: () => void) => fn(),
      register: (entry: Record<string, unknown>) => {
        if (entry.name === "conversation.input.right") {
          dockInjector = entry.inject as (sessionId: unknown) => unknown;
        }
      },
    },
  };
  apply(ctx as never);
  if (dockInjector === undefined) {
    throw new Error("expected the meter's injector to be registered");
  }
  const injected = dockInjector("valid") as
    | { readUsage?: InjectedReadUsage<T> }
    | undefined;
  if (typeof injected?.readUsage !== "function") {
    throw new TypeError("expected the injector to hand the meter a readUsage");
  }
  return injected.readUsage;
};
