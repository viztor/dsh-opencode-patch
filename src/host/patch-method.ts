/**
 * The one way this plugin wraps a method on a host object.
 *
 * Every instance patch in `src/` goes through {@link patchMethod}: the listing,
 * discovery and model-info wrappers on the `llm` service and the plane adapters'
 * `resolveModel`, `prepareCall` and `modelOf` (all in `models-discovery.ts`).
 * Wrapping an INSTANCE is enough because the host resolves a service method per
 * call (F20: the gateway reads it with `Reflect.get` at dispatch), so a wrapper
 * set on the instance is what every later caller runs.
 *
 * A host activation is not always the only one. cordis disposes before it
 * re-applies (a config update is `Fiber.update` → `restart` → `_unload`, which
 * awaits every disposer, → `_reload`), but two activations are live at once
 * when two rows load the plugin, and on the base a dispose that silently
 * restored nothing left its wrapper for the next activation to wrap. Another
 * plugin may also wrap the same method on top of ours. Three rules follow, and
 * the module exists to keep them in one place:
 *
 * - **A dispose restores only what is still ours.** When the own property no
 *   longer holds the wrapper this install defined, something wrapped on top of
 *   it, and that wrapper captured ours: ours turns into a pass-through instead
 *   of being torn out from under it. A pass-through hands the call to the
 *   newest same-site install it replaced that is still live, and to the method
 *   it wrapped only when none is.
 * - **An inherited original is restored by deletion.** Assigning the prototype's
 *   method back leaves an own property that shadows the prototype for good; the
 *   exact original state is "no own property", so the property is deleted. An
 *   own original gets its exact descriptor back, attributes included.
 * - **A second install of the same site wraps the UNPATCHED method**, never the
 *   previous install: the prototype's method when the original was inherited,
 *   the recorded own original otherwise. Each install remembers the newest live
 *   same-site install it replaced, so either disposal order ends at the exact
 *   original.
 *
 * A retired install keeps no wrapper alive: its record drops the function `wrap`
 * built (which closes over that activation's context and config), and the
 * links between same-site records drop the retired ones the next time a call,
 * an install or a dispose walks them, so a long-running host that reloads the
 * plugin holds the live installs and nothing else. A retired
 * wrapper of ours that becomes the current value again (a foreign wrapper put
 * back the EXACT function on its own teardown, read through an untrapped handle
 * or an own descriptor) is nobody's: the next dispose of this key collapses it
 * to what it replaced.
 *
 * The limit of that collapse: a foreign plugin that reads and later puts back
 * through `ctx.llm` puts back a cordis shadow-method proxy, not our function,
 * and a record is found by exact identity, so the proxy reads as foreign. It
 * stays an own property and a correct pass-through (to the retired trampoline,
 * which falls through as any retired install does), and a later install wraps
 * it; `test/patch-method.test.ts` pins this on tier A.
 * Seeing through it is not offered on purpose: a tag read through the proxy
 * would read just as well through a foreign `new Proxy(ours, { apply })` that
 * DECORATES ours, and a dispose would then tear that live wrapper out.
 *
 * **Identity is read from own descriptors, never with `===` on a property
 * read.** On the real host `ctx.llm` is cordis's traceable proxy: a read of a
 * function-valued property answers a NEW shadow-method proxy every time
 * (`createTraceable` / `createShadowMethod`, the harness's
 * `vendor/cordis/src/utils.ts:156-218`), and a `Service`'s tracker carries no
 * `noShadow` (`vendor/cordis/src/service.ts:46-49`). So `llm.discoverModels ===
 * decorated` is never true there, and a disposer that checked it never
 * restored: measured with a real `LlmRuntime`, every wrapper stayed installed
 * after its dispose and a reload stacked the next one on top.
 * `Reflect.getOwnPropertyDescriptor`, `Reflect.getPrototypeOf`,
 * `Reflect.defineProperty` and `Reflect.deleteProperty` are not trapped by that
 * proxy, so they see the instance itself.
 *
 * @module dsh-opencode-patch/host/patch-method
 */

import type { CordisContext } from "../cordis-context.ts";
import { isFunctionLike } from "../utils/guards.ts";

/** The method a wrapper delegates to: the host's own, before any of ours. */
export type UnpatchedMethod = (...args: unknown[]) => unknown;

/** What names one patch site. */
export interface PatchMethodOptions {
  /**
   * The SITE, not the install: two activations of the same site share it, which
   * is how the second one knows to replace the first rather than wrap it.
   */
  readonly id: string;
}

/** Where the true original lives: on the prototype, or in this own descriptor. */
type Slot =
  | { readonly inherited: true }
  | { readonly inherited: false; readonly descriptor: PropertyDescriptor };

/** One install, keyed by the function it defined. */
interface PatchRecord {
  readonly id: string;
  readonly key: string;
  readonly slot: Slot;
  readonly installed: (...args: never[]) => unknown;
  /** What `wrap` built: held while live, dropped on retire. */
  impl: ((...args: never[]) => unknown) | undefined;
  /** The newest same-site install this one replaced, which it hands back to. */
  replaced: PatchRecord | undefined;
  live: boolean;
}

/**
 * Every install's record, by the function it defined. A WeakMap, so an entry
 * lives exactly as long as its function is reachable from some host object.
 */
const records = new WeakMap<object, PatchRecord>();

/** The record of a function this module installed under `key`, if it is one. */
const recordOf = (value: unknown, key: string): PatchRecord | undefined => {
  if (!isFunctionLike(value)) {
    return undefined;
  }
  const record = records.get(value);
  return record?.key === key ? record : undefined;
};

/**
 * The method the slot names: the own original's value, or the value of the
 * first data property up the prototype chain. An accessor, own or inherited,
 * has no value and so answers `undefined`, which refuses the install: a getter
 * is never run, and a snapshot of what it answered is never installed.
 */
const unpatchedFor = (target: object, key: string, slot: Slot): unknown => {
  if (!slot.inherited) {
    return slot.descriptor.value;
  }
  for (
    let proto = Reflect.getPrototypeOf(target);
    proto !== null;
    proto = Reflect.getPrototypeOf(proto)
  ) {
    const descriptor = Reflect.getOwnPropertyDescriptor(proto, key);
    if (descriptor !== undefined) {
      return descriptor.value;
    }
  }
  return undefined;
};

/**
 * The newest live record from `start` down its `replaced` chain, relinking each
 * live record in it past the retired ones, so a retired record is reachable from
 * no live one and is released with the function that defined it.
 */
const compactFrom = (
  start: PatchRecord | undefined
): PatchRecord | undefined => {
  let head: PatchRecord | undefined;
  let last: PatchRecord | undefined;
  for (let record = start; record !== undefined; record = record.replaced) {
    if (!record.live) {
      continue;
    }
    if (last === undefined) {
      head = record;
    } else {
      last.replaced = record;
    }
    last = record;
  }
  if (last !== undefined) {
    last.replaced = undefined;
  }
  return head;
};

/**
 * Put back what was there before `record`: the newest live same-site install it
 * replaced, else the true original. A retired wrapper of ours found as the
 * original is nobody's original, so it is collapsed to what IT replaced.
 */
const restoreFor = (
  target: object,
  key: string,
  record: PatchRecord,
  current: PropertyDescriptor
): void => {
  const heir = compactFrom(record.replaced);
  record.replaced = heir;
  if (heir !== undefined) {
    Reflect.defineProperty(target, key, { ...current, value: heir.installed });
    return;
  }
  const { slot } = record;
  if (slot.inherited) {
    Reflect.deleteProperty(target, key);
    return;
  }
  const retired = recordOf(slot.descriptor.value, key);
  if (retired !== undefined && !retired.live) {
    restoreFor(target, key, retired, current);
    return;
  }
  Reflect.defineProperty(target, key, slot.descriptor);
};

/**
 * Wrap `target[key]` with what `wrap` builds from the unpatched method.
 *
 * `wrap` runs once, before the property is defined, and its result is called
 * with the caller's receiver. What is defined is a plain (never `async`)
 * trampoline in front of it, so a synchronous method stays synchronous and a
 * retired install can fall through: to the newest live same-site install it
 * replaced, else to the method it wrapped.
 *
 * @param target - the host object (a service instance, or an adapter).
 * @param key - the method's name.
 * @param wrap - builds the wrapper from the unpatched method.
 * @param options - the patch site's id.
 * @returns the disposer, or `undefined` when nothing was installed: the key
 *   holds no method (an accessor included, own or inherited), or the target
 *   refused the define (a frozen method, a non-extensible object, a refusing
 *   proxy).
 */
export const patchMethod = (
  target: object,
  key: string,
  wrap: (unpatched: UnpatchedMethod) => (...args: never[]) => unknown,
  options: PatchMethodOptions
): (() => void) | undefined => {
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  const ours = recordOf(own?.value, key);
  const same = ours?.id === options.id ? ours : undefined;
  const slot: Slot =
    same?.slot ??
    (own === undefined
      ? { inherited: true }
      : { descriptor: own, inherited: false });
  const unpatched = unpatchedFor(target, key, slot);
  if (!isFunctionLike(unpatched)) {
    return undefined;
  }
  // Called only after `record` below exists: the define comes after it.
  const installed = function installed(
    this: unknown,
    ...args: never[]
  ): unknown {
    if (record.impl !== undefined) {
      return Reflect.apply(record.impl, this, args);
    }
    const heir = compactFrom(record.replaced);
    record.replaced = heir;
    return heir === undefined
      ? Reflect.apply(unpatched, this, args)
      : Reflect.apply(heir.installed, this, args);
  };
  const record: PatchRecord = {
    id: options.id,
    impl: wrap(unpatched),
    installed,
    key,
    live: true,
    replaced: compactFrom(same),
    slot,
  };
  let defined: boolean;
  try {
    defined = Reflect.defineProperty(
      target,
      key,
      own === undefined
        ? {
            configurable: true,
            enumerable: true,
            value: installed,
            writable: true,
          }
        : { ...own, value: installed }
    );
  } catch {
    defined = false;
  }
  if (!defined) {
    return undefined;
  }
  records.set(installed, record);
  return () => {
    record.live = false;
    record.impl = undefined;
    // Whatever is current now: ours (this install, or a retired one of ours a
    // foreign wrapper put back) is collapsed; anything else wrapped on top and
    // keeps what it captured.
    const current = Reflect.getOwnPropertyDescriptor(target, key);
    const top = recordOf(current?.value, key);
    if (current === undefined || top === undefined || top.live) {
      return;
    }
    restoreFor(target, key, top, current);
  };
};

/**
 * What this module knows about a function it installed: its site, whether it is
 * live, whether it still holds the wrapper `wrap` built, and the same-site
 * installs it would hand back to, newest first. `undefined` for any other value.
 * For tests and diagnostics; it changes nothing.
 */
export const inspectPatch = (
  value: unknown,
  key: string
):
  | readonly { id: string; live: boolean; holdsWrapper: boolean }[]
  | undefined => {
  const chain: { id: string; live: boolean; holdsWrapper: boolean }[] = [];
  for (
    let record = recordOf(value, key);
    record !== undefined;
    record = record.replaced
  ) {
    chain.push({
      holdsWrapper: record.impl !== undefined,
      id: record.id,
      live: record.live,
    });
  }
  return chain.length === 0 ? undefined : chain;
};

/**
 * Install now, and again after every `llm/adapters-updated`, for a site that
 * has to follow the adapter registry rather than the registry it saw first.
 *
 * Wired to no site yet: on the plane-adapter decoration it would wrap pi-ai's
 * shared adapter in the plugin-first order too, and flip the host
 * characterization's `[KNOWN_DEFECT]` rows.
 *
 * Two things the first caller has to know. The listener reinstalls on EVERY
 * registry change while it is live, the caller's own included, so a caller that
 * also registers adapters disposes this BEFORE it releases them: the release
 * emits `llm/adapters-updated` synchronously, and a live listener would
 * reinstall the site once per registration the release withdraws (today each
 * Google bridge handle and the mounted pi-ai's adapter handle; its
 * configurable-provider registration is answered locally by the mount's facade
 * and emits nothing). The fetch-patch cleanup in `lifecycle.ts` releases the
 * hidden routes first, so order it there when this is wired. And `install` runs synchronously inside the host's per-listener
 * `try`/`catch` in `LlmRuntime.emitAdaptersUpdated`, so a throw from a
 * reinstall is logged by the host, not propagated to the plugin.
 *
 * @param ctx - the context whose (global) registry events to follow.
 * @param install - one install; answers its disposer, or `undefined`.
 * @returns the disposer: stops listening and disposes the current install.
 */
export const rewrapOnAdaptersUpdated = (
  ctx: Pick<CordisContext, "on">,
  install: () => (() => void) | undefined
): (() => void) => {
  let active = true;
  let current = install();
  const off: unknown = ctx.on?.(
    "llm/adapters-updated",
    () => {
      if (!active) {
        return;
      }
      current?.();
      current = install();
    },
    // Defensive: today's emitter dispatches this event with no `thisArg`, so
    // cordis applies no filter and a local listener hears it too. `global`
    // keeps it heard if the emitter ever passes a filtered context.
    { global: true }
  );
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (isFunctionLike(off)) {
      off();
    }
    current?.();
    current = undefined;
  };
};
