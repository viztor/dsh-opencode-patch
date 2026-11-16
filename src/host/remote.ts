/**
 * The one installer for the plugin's remote services: the usage meter's
 * `opencodeGoUsage`, the card's `opencodeModelPurge` and its `opencodeStore`
 * inspection.
 *
 * Three rules shape it, and each replaced a copy that got one of them wrong.
 *
 * - **A service mounts on the ROOT context.** The Gateway exposes a namespace
 *   it finds among the root's services, and the purge service reads its own
 *   context to decide which realm a profile belongs to (D27), so the service's
 *   context has to be the process's, not one activation's.
 * - **One service per root, alive while a live activation holds it.** The host
 *   applies the plugin more than once at a time (two rows, or a reload), and a
 *   second `root.plugin(Service)` for a name still registered is refused as a
 *   duplicate; tied to the first activation, the service then went with it and
 *   left none. So the activations share one mount, the service reads the
 *   options of the most recently applied activation that is still live (a
 *   reload's new settings, and the remaining row's once the latest one goes),
 *   and the last activation to go disposes it: disabling the plugin withdraws
 *   it, and a reload, which unloads before it applies again, mounts it anew.
 *   The options reach the service as a view onto that activation's, so they
 *   stay current only for a value the service reads per call, as
 *   `GoUsageService` reads its base URL and key source; a value read at
 *   construction is the mounting activation's.
 * - **Every outcome is reported, through the activation's own logger, after
 *   the mount has settled.** cordis loads a plugin after a microtask, so a
 *   check made right after `root.plugin` reads a service that does not exist
 *   yet. The check waits for the fiber, then reads the service back under its
 *   service key and says whether the Gateway can reach it: a `typertRemote`
 *   binding for the namespace the client contract calls. The key (`service`)
 *   and the wire namespace (`namespace`) are read from the contract apart,
 *   as the Gateway reads them, though all three contracts give both one name.
 *
 * There is no `ctx.provide` arm. A provided value is invisible to the Gateway,
 * whose discovery needs a binding whose `service` is the registered original
 * (`api/gateway/src/index.ts:385-396,1546-1559` in the harness), and
 * constructing a `TypertRemoteService` needs `ctx.reflect`, which only a real
 * `Context` has, and a real `Context` always has `plugin`. A composition
 * without `plugin` is reported, service by service, and mounts nothing.
 *
 * Two separately installed copies of this module would keep two sets of slots;
 * the second copy's mount is then refused as a duplicate, which is reported
 * like any refused mount. The refused copy does not mount again when the
 * other copy's row goes: disabling the row that mounted withdraws the
 * service until the refused copy's own row is applied again. Two copies
 * already collide on the route claim and the fetch patch, so this is a known
 * limitation of an unsupported setup, not a case the installer retries.
 *
 * @module dsh-opencode-patch/host/remote
 */

import type { CordisContext } from "../cordis-context.ts";
import { isFunctionLike, isRecord } from "../utils/guards.ts";

/**
 * The client's remote contribution, as far as the installer reads it: the
 * service every descriptor calls (its Cordis key), the namespace the Gateway
 * binds it under, and the methods it calls on it. `usageRemote`,
 * `purgeRemote` and `storeRemote` satisfy it as they are.
 */
export interface RemoteContract {
  readonly descriptors: readonly {
    readonly service: string;
    readonly namespace: string;
    readonly method: string;
  }[];
}

/** The one service and namespace a contract's descriptors all name. */
interface Target {
  readonly service: string;
  readonly namespace: string;
}

/** The fiber `root.plugin` answered: what waits for its load, and what unloads it. */
interface StartedFiber {
  readonly await: () => unknown;
  readonly dispose: () => unknown;
}

/** One activation holding a service. */
interface Holder {
  readonly ctx: CordisContext;
  readonly options: object | undefined;
  live: boolean;
}

/** How a mount settled: loaded, or refused with its fiber's error. */
type Outcome =
  | { readonly failed: false }
  | {
      readonly failed: true;
      readonly error: unknown;
      readonly fiber: StartedFiber;
    };

/** One `root.plugin` call, and the promise of how it settled. */
interface Mount {
  /** `undefined` when the composition's `plugin` answered no fiber. */
  readonly fiber: StartedFiber | undefined;
  readonly settled: Promise<Outcome>;
}

/** One service on one root: its live holders, in apply order, and its mount. */
interface Slot {
  readonly holders: Holder[];
  mount: Mount | undefined;
}

/**
 * The slots, per root and then per service key. Keyed weakly by the root, so a
 * root nothing references any more takes its slots with it; a slot is deleted
 * when its last holder goes.
 */
const slotsByRoot = new WeakMap<object, Map<string, Slot>>();

const PREFIX = "[dsh-opencode-patch]";

/** The distinct values one descriptor field takes across a contract. */
const distinct = (
  contract: RemoteContract,
  field: "namespace" | "service"
): string[] => [
  ...new Set(contract.descriptors.map((descriptor) => descriptor[field])),
];

/**
 * The one service and the one namespace every descriptor names, or
 * `undefined` when either is none or several.
 */
const targetOf = (contract: RemoteContract): Target | undefined => {
  const [service, ...otherServices] = distinct(contract, "service");
  const [namespace, ...otherNamespaces] = distinct(contract, "namespace");
  return service === undefined ||
    namespace === undefined ||
    otherServices.length > 0 ||
    otherNamespaces.length > 0
    ? undefined
    : { namespace, service };
};

/** What the client finds missing when the service is: its calls, by name. */
const tailOf = ({ namespace }: Target, contract: RemoteContract): string =>
  `the client's ${contract.descriptors
    .map(({ method }) => `${namespace}.${method}`)
    .join(", ")} will find nothing`;

/**
 * A fiber is an object with `await` and `dispose`; anything else is none.
 * Both are called on the object they were read from.
 */
const asFiber = (value: unknown): StartedFiber | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { await: settle, dispose } = value;
  return isFunctionLike(settle) && isFunctionLike(dispose)
    ? {
        await: (): unknown => Reflect.apply(settle, value, []),
        dispose: (): unknown => Reflect.apply(dispose, value, []),
      }
    : undefined;
};

/**
 * The options of the latest live holder that has any, else the mounting
 * activation's: a view's traps read through this on every access.
 */
const latestOptions = (slot: Slot, fallback: object): object =>
  slot.holders.findLast((holder) => holder.options !== undefined)?.options ??
  fallback;

/**
 * A view that reads the latest live holder's options, else `options` (the
 * mounting activation's). Its target is a fresh empty object, so no Proxy
 * invariant ties a read to a frozen or non-configurable holder's property.
 * It reads through and refuses every write: a `set`, a define, a delete and a
 * freeze each answer false (a TypeError at the write site in strict code), so
 * the target stays empty and every read still answers the latest live
 * holder's value.
 */
const optionsView = <Options extends object>(
  slot: Slot,
  options: Options
): Options =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the empty target only anchors the traps; every read goes to a holder's options
  new Proxy<Options>({} as Options, {
    get: (_target, key) => {
      const value: unknown = Reflect.get(latestOptions(slot, options), key);
      return value;
    },
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        latestOptions(slot, options),
        key
      );
      // Reported configurable: the empty target lacks every key, and a key
      // the target lacks may only be reported as one.
      return descriptor === undefined
        ? undefined
        : { ...descriptor, configurable: true };
    },
    has: (_target, key) => Reflect.has(latestOptions(slot, options), key),
    ownKeys: () => Reflect.ownKeys(latestOptions(slot, options)),
    // Refused, never forwarded: a write that reached the empty target would
    // define a key the other traps then contradict.
    defineProperty: () => false,
    deleteProperty: () => false,
    preventExtensions: () => false,
    set: () => false,
  });

/** Dispose a mount's fiber, reporting a dispose that throws rather than raising it. */
const disposeFiber = async (
  fiber: StartedFiber,
  holder: Holder,
  service: string
): Promise<void> => {
  try {
    await fiber.dispose();
  } catch (error) {
    holder.ctx.logger?.warn?.(
      `${PREFIX} ${service} did not dispose cleanly`,
      error
    );
  }
};

/** How a fiber settles, as a value: the promise never rejects. */
const settle = async (fiber: StartedFiber): Promise<Outcome> => {
  try {
    await fiber.await();
    return { failed: false };
  } catch (error) {
    return { error, failed: true, fiber };
  }
};

/**
 * Start the service on the root. A synchronous throw is reported and leaves
 * no mount, so a later activation tries again.
 */
const mount = (
  plugin: (...args: unknown[]) => unknown,
  root: CordisContext,
  args: readonly unknown[],
  holder: Holder,
  service: string
): Mount | undefined => {
  let started: unknown;
  try {
    started = Reflect.apply(plugin, root, args);
  } catch (error) {
    holder.ctx.logger?.warn?.(`${PREFIX} ${service} did not mount`, error);
    return undefined;
  }
  const fiber = asFiber(started);
  if (fiber === undefined) {
    // A composition whose `plugin` answers no fiber: nothing to wait for or
    // to dispose, and the read-back below says what it registered.
    return { fiber, settled: Promise.resolve({ failed: false }) };
  }
  return { fiber, settled: settle(fiber) };
};

/**
 * Read the service back under its key and say whether the Gateway can reach
 * it: a binding for the namespace the client calls, as the Gateway checks it.
 */
const verify = (
  root: CordisContext,
  holder: Holder,
  target: Target,
  contract: RemoteContract
): void => {
  const { logger } = holder.ctx;
  const { namespace, service } = target;
  let resolved: unknown;
  try {
    resolved = typeof root.get === "function" ? root.get(service) : undefined;
  } catch {
    // An unregistered name answers undefined on some hosts and throws on others.
    resolved = undefined;
  }
  if (!isRecord(resolved)) {
    logger?.warn?.(
      `${PREFIX} ${service} did not register: ctx.get('${service}') answered nothing`,
      tailOf(target, contract)
    );
    return;
  }
  const binding: unknown = resolved.typertRemote;
  if (!isRecord(binding)) {
    logger?.warn?.(
      `${PREFIX} ${service} registered but carries no typertRemote binding`,
      "the Gateway's source-mode discovery will not find it; ctx.provide() publishes a value, not a Service",
      tailOf(target, contract)
    );
    return;
  }
  if (binding.namespace !== namespace) {
    logger?.warn?.(
      `${PREFIX} ${service} is bound for namespace ${String(binding.namespace)}, not ${namespace}, the one the client calls`
    );
    return;
  }
  logger?.info?.(
    `${PREFIX} ${service} is reachable with a typertRemote binding for namespace %s`,
    namespace
  );
};

/**
 * Once the mount has settled: say nothing for an activation that has gone,
 * report a refused mount (and dispose its failed fiber, so a later activation
 * mounts anew), and otherwise verify the service.
 */
const report = async (
  root: CordisContext,
  slot: Slot,
  current: Mount,
  holder: Holder,
  target: Target,
  contract: RemoteContract
): Promise<void> => {
  const { service } = target;
  const outcome = await current.settled;
  if (!holder.live) {
    return;
  }
  if (outcome.failed) {
    holder.ctx.logger?.warn?.(
      `${PREFIX} ${service} did not mount`,
      outcome.error
    );
    if (slot.mount === current) {
      slot.mount = undefined;
      await disposeFiber(outcome.fiber, holder, service);
    }
    return;
  }
  verify(root, holder, target, contract);
};

/**
 * Hold the service for one activation: mount it on the root unless a live
 * activation already has, and answer the report and the release.
 */
const acquire = (
  plugin: (...args: unknown[]) => unknown,
  root: CordisContext,
  Service: unknown,
  holder: Holder,
  target: Target,
  contract: RemoteContract
): {
  readonly reported: Promise<void>;
  readonly release: () => Promise<void>;
} => {
  const { service } = target;
  let slots = slotsByRoot.get(root);
  if (slots === undefined) {
    slots = new Map();
    slotsByRoot.set(root, slots);
  }
  let slot = slots.get(service);
  if (slot === undefined) {
    slot = { holders: [], mount: undefined };
    slots.set(service, slot);
  }
  slot.holders.push(holder);
  slot.mount ??= mount(
    plugin,
    root,
    holder.options === undefined
      ? [Service]
      : [Service, optionsView(slot, holder.options)],
    holder,
    service
  );
  const held = slot;
  const owned = slots;
  return {
    // Synchronous up to the dispose, and returned, so cordis awaits the
    // dispose in the activation's unload: a reload then finds no slot and
    // mounts anew.
    release: async () => {
      holder.live = false;
      held.holders.splice(held.holders.indexOf(holder), 1);
      if (held.holders.length > 0) {
        return;
      }
      owned.delete(service);
      const fiber = held.mount?.fiber;
      held.mount = undefined;
      if (fiber !== undefined) {
        await disposeFiber(fiber, holder, service);
      }
    },
    reported:
      held.mount === undefined
        ? Promise.resolve()
        : report(root, held, held.mount, holder, target, contract),
  };
};

/**
 * Mount a remote service on the root for this activation, as described in the
 * module doc.
 *
 * @param ctx - the activation's context; its logger carries every report.
 * @param Service - the service class (a `TypertRemoteService`).
 * @param contract - the client's contribution: names the service and its
 *   namespace, and the calls a report says will find nothing.
 * @param options - the service's constructor options, if it takes any.
 * @returns a promise that settles once the mount has been checked and
 *   reported; it never rejects.
 */
export const installRemoteService = <Options extends object>(
  ctx: CordisContext,
  Service: new (ctx: never, options?: Options) => unknown,
  contract: RemoteContract,
  options?: Options
): Promise<void> => {
  const target = targetOf(contract);
  if (target === undefined) {
    ctx.logger?.warn?.(
      `${PREFIX} a remote contract naming no single service and namespace was not mounted`,
      distinct(contract, "service"),
      distinct(contract, "namespace")
    );
    return Promise.resolve();
  }
  const { service } = target;
  const root: CordisContext = ctx.root ?? ctx;
  const { plugin } = root;
  if (!isFunctionLike(plugin)) {
    ctx.logger?.warn?.(
      `${PREFIX} ${service} did not mount: this composition has no ctx.plugin`,
      tailOf(target, contract)
    );
    return Promise.resolve();
  }
  const holder = { ctx, live: true, options };
  let reported: Promise<void> = Promise.resolve();
  const hold = (): (() => unknown) => {
    const held = acquire(plugin, root, Service, holder, target, contract);
    ({ reported } = held);
    return held.release;
  };
  if (isFunctionLike(ctx.effect)) {
    ctx.effect(hold, `dsh-opencode-patch.remote.${service}`);
  } else {
    // A composition with no effects has no unload either: the hold is for good.
    hold();
  }
  return reported;
};
