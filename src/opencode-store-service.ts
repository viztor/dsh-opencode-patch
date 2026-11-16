/**
 * Remote service for inspecting a local OpenCode installation.
 *
 * Answers the settings card's "check this machine" question: is there an OpenCode
 * credential store here, which account does it belong to, and is it still valid?
 *
 * Two rules shape it, and both are about what must NOT leave the host:
 *
 * 1. **No secret ever crosses the seam.** The answer is a sanitized summary —
 *    email, org, credential kind, expiry — and never the token. The reader it
 *    calls ({@link inspectOpencodeStore}) is built the same way, so there is no
 *    intermediate value to leak.
 * 2. **No machine layout either.** The database path is rewritten to `~`-relative
 *    before it is returned: the card shows WHERE it looked, which is useful, but
 *    a home directory is a fact about this machine and not about the plugin.
 *
 * @module dsh-opencode-patch/opencode-store-service
 */

import os from "node:os";

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  STORE_NAMESPACE,
  storeRemote,
  type OpencodeStoreInspection,
} from "./contracts/store.ts";
import { markRemote } from "./host/remote.ts";
import { opencodeDatabasePath } from "./opencode-paths.ts";
import { inspectOpencodeStore } from "./opencode-store.ts";
import { isRecord } from "./utils/guards.ts";

export class OpencodeStoreService extends TypertRemoteService {
  constructor(ctx: unknown, options?: unknown) {
    if (!isRecord(ctx)) {
      throw new TypeError(
        "OpencodeStoreService requires a Cordis context object"
      );
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the guard above is the runtime check this cast stands in for.
    super(ctx as never, STORE_NAMESPACE);
    const { resolveStorePath } = isRecord(options) ? options : {};
    this.resolveStorePath =
      typeof resolveStorePath === "function"
        ? (resolveStorePath as () => string)
        : defaultStorePath;
  }

  /**
   * Where the installation's database lives, as a function rather than a value:
   * it depends on the ambient home and environment, which belong to the process
   * at call time. Injectable so a test can point it at a fixture database
   * without an OpenCode installation.
   */
  readonly resolveStorePath: () => string;

  /** Summarize the installation's stored credential, without the credential. */
  inspect(): Promise<OpencodeStoreInspection> {
    const result = inspectOpencodeStore(this.resolveStorePath());
    return Promise.resolve({ ...result, path: shownPath(result.path) });
  }
}

/**
 * The store path, made safe to show.
 *
 * The card may say WHERE it looked — that is what turns a not-found answer into
 * something the reader can act on — but a home directory is a fact about this
 * machine and not about the plugin. So a path under the home directory becomes
 * `~`-relative, and one anywhere else keeps only its basename: `$OPENCODE_DB`
 * can point outside the home tree, and that case must not leak the rest of it.
 *
 * @param path - the absolute path the reader opened, when it reported one.
 * @returns the displayable path, or `undefined` when there was none.
 */
const shownPath = (path: string | undefined): string | undefined => {
  if (path === undefined) {
    return undefined;
  }
  const home = os.homedir();
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
};

/** The database path the local installation itself would use. */
const defaultStorePath = (): string =>
  opencodeDatabasePath(
    {
      channel: process.env.OPENCODE_CHANNEL,
      env: process.env,
      home: os.homedir(),
    },
    os.tmpdir()
  );

markRemote(OpencodeStoreService, storeRemote);
