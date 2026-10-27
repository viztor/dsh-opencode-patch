/**
 * The live suites' environment, read in one place.
 *
 * Every switch the end-to-end files obey — whether the live suite runs, which
 * key tier is armed, a mirror's base URLs, where the record goes, the CI run
 * that produced it, and the published-host cell — is read here and nowhere
 * else, so what arms a key is decided by one function a reader can find, and
 * a unit test can call with an environment of its own. `keyed-probes.ts`
 * stays pure: it decides from the values this module reads.
 *
 * An `OPENCODE_E2E_KEYED` the tier reader does not know fails each e2e file at
 * import (each calls {@link e2e} at module level), which is the run failing
 * rather than silently arming or disarming a suite. Loading this module reads
 * nothing, so the unit file that drives the reader loads it safely.
 *
 * @module test/support/e2e-env
 */
import { armedKey, type KeyedTier, keyedTierOf } from "./keyed-probes.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** What the live suites read from the environment. */
export interface E2eEnvironment {
  /** `OPENCODE_E2E=1`: the live suite runs at all. */
  readonly live: boolean;
  /** `OPENCODE_E2E_KEYED`: what may spend a key. */
  readonly tier: KeyedTier;
  /** Either plane's base is overridden: the suite points at a mirror. */
  readonly mirrored: boolean;
  /** A base to use instead of the vendor's, per plane, when one is set. */
  readonly baseOverride: { readonly go?: string; readonly zen?: string };
  /** Where the dated record tables go; empty means nowhere. */
  readonly recordDir: string;
  /** The CI run a record links to, when there is one. */
  readonly run: {
    readonly repository: string | undefined;
    readonly runId: string | undefined;
    readonly server: string | undefined;
  };
  /** The published-host binary e2e (`DSH_HOST_E2E=1`) and its inputs. */
  readonly hostBinary: {
    readonly enabled: boolean;
    readonly prefix: string;
    readonly cell: string;
    readonly probeCopy: string;
    /** The `PATH` the binary is started with. */
    readonly path: string;
  };
  /**
   * The key a suite needing `need` may spend on `plane`, or `undefined` —
   * which every keyed suite reads as "skip".
   */
  readonly keyFor: (
    plane: "opencode" | "opencode-go",
    need: "full" | "probes"
  ) => string | undefined;
}

/** A value, or `undefined` when it is unset or blank. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

/**
 * Read the live suites' environment.
 *
 * @param env - the environment to read; the process's own by default.
 * @returns what the live suites obey.
 */
export const readE2eEnvironment = (
  env: Environment = process.env
): E2eEnvironment => {
  const tier = keyedTierOf(env.OPENCODE_E2E_KEYED);
  const zen = nonEmpty(env.OPENCODE_ZEN_BASE_URL);
  const go = nonEmpty(env.OPENCODE_GO_BASE_URL);
  return {
    baseOverride: {
      ...(go === undefined ? {} : { go }),
      ...(zen === undefined ? {} : { zen }),
    },
    hostBinary: {
      cell: env.DSH_HOST_PI_CELL ?? "pinned",
      enabled: env.DSH_HOST_E2E === "1",
      path: env.PATH ?? "",
      prefix: env.DSH_HOST_PREFIX ?? "",
      probeCopy: env.DSH_HOST_PROBE_COPY ?? "",
    },
    keyFor: (plane, need) =>
      armedKey(
        tier,
        need,
        plane === "opencode" ? env.OPENCODE_API_KEY : env.OPENCODE_GO_API_KEY
      ),
    live: env.OPENCODE_E2E === "1",
    mirrored: zen !== undefined || go !== undefined,
    recordDir: env.OPENCODE_E2E_RECORD_DIR ?? "",
    run: {
      repository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      server: env.GITHUB_SERVER_URL,
    },
    tier,
  };
};

let processEnvironment: E2eEnvironment | undefined;

/**
 * The process's own live-suite environment, read on first call and kept.
 *
 * A function rather than a constant evaluated at import, so loading this
 * module reads nothing: the unit file that drives {@link readE2eEnvironment}
 * with environments of its own (`test/e2e-env.test.ts`) does not fail at
 * collection in a shell exporting an unknown `OPENCODE_E2E_KEYED`. Each e2e
 * file calls it at module level, so an unknown tier still fails the e2e suite
 * at import.
 *
 * @returns the environment of the running process.
 */
export const e2e = (): E2eEnvironment =>
  (processEnvironment ??= readE2eEnvironment());
