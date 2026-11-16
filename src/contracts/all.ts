/**
 * Every remote contract this plugin defines, in one list.
 *
 * The client mounts them as ONE contribution (`patchRemote` in
 * `src/settings-page.tsx`): Typert enforces a unique package name per
 * contribution. A new remote is one `defineRemote`, one entry here, one
 * `markRemote` on its service and one `installRemoteService` in
 * `src/lifecycle.ts`. Kept apart from `remote.ts` so the builder imports none
 * of the contracts it builds.
 *
 * @module dsh-opencode-patch/contracts/all
 */

import { purgeRemote } from "./purge.ts";
import { storeRemote } from "./store.ts";
import { usageRemote } from "./usage.ts";

/** Usage, purge, store: the order the client's descriptors have always had. */
export const REMOTE_CONTRACTS = [
  usageRemote,
  purgeRemote,
  storeRemote,
] as const;
