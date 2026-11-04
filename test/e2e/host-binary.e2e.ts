/**
 * The published host binary, booted with this plugin and the measurement probe.
 *
 * The in-process tiers (`test/support/host.ts`) assemble the host from the
 * packages this repository installs; this file boots the real thing — the
 * `@deepseek-ai/dsh` the `e2e-host` job installs into a throwaway prefix — the
 * way a user's profile does: a temporary HOME, a profile whose `package.json`
 * links this checkout and the probe bundle (`test/e2e/host/`) through RELATIVE
 * `link:` paths, `dsh plugin … install`, then `dsh --profile e2e --no-open`.
 * The probe records what the host serves and exits the process; this file reads
 * its JSON.
 *
 * The assertions are the plugin's behaviour, read from `S0_TODAY_BY_CELL` for
 * the host cell this run installed, the same tables the in-process
 * characterization pins, so the binary and the harness cannot drift apart
 * unnoticed. Since P-R1 the plugin owns both plane routes (D13): no row
 * depends on which of pi-ai and the plugin applies first, so the per-model
 * rows are the cell's `rows` in either order, and the listing and save rows no
 * longer depend on which ids pi describes. The Settings fetch rows (P3) are
 * checked against this checkout's servable shim catalog, and their order
 * against the list the prefix's own pi exports, in every cell where the route
 * claim engages.
 *
 * Gated: it runs only with `DSH_HOST_E2E=1`, and needs `DSH_HOST_PREFIX`, a
 * directory whose `node_modules/@deepseek-ai/dsh` is the installed host of the
 * channel `DSH_CHANNEL` names (`alpha` by default; `host-versions.ts` holds
 * both channels' records). The installed dsh must be that record's.
 * `DSH_HOST_PI_CELL` says which pi the prefix holds, both unpatched (D14''):
 *
 * - `npm` (the default): the published host exactly as npm resolved it, cordis
 *   and pi included, what an npm user of the channel runs. Its rows are the
 *   `newest` cell's while the resolved pi is the channel record's `pi`. A pi
 *   published since the record was cut is still asserted to sit in the
 *   bridge's range, but the per-model rows (a newer pi's own entry can still
 *   move a model's metadata where the catalog states none) are skipped with a
 *   warning: the nightly drift report names the new pi, and its probe JSON is
 *   the record.
 * - `floor`: the tree the desktop app ships: npm `overrides`
 *   (`floorOverrides`) force the channel's cordis family at the record's
 *   versions and pi (with its telemetry package) at the range's floor; this
 *   file asserts npm applied each one. Every row is the channel's floor cell.
 *
 * In both cells the record's family is held to something the record does not
 * produce: each member must be the floor of the `~` range the installed
 * published package declares for it (`FAMILY_DECLARERS`; overrides rewrite
 * what is installed, never a manifest's declared range). One rule narrows it:
 * cosmokit's declarer is cordis, so cosmokit is checked only where the
 * installed cordis is the record's; elsewhere only the nightly drift report
 * checks it. Today that leaves it out of alpha's `npm` cell, where cordis
 * floats to a newer patch.
 *
 * Two host limitations are recorded as `[HOST_LIMITATION]` rows, each detected
 * from what the host itself answers, never from a version (D26):
 *
 * - Only the `npm` cell lets cordis float, as the published host's `~` ranges
 *   do for a user. Where what it resolved leaves the host unable to run its
 *   own save path, the save rows skip: the plane edit AND a control edit no
 *   plugin's listener reads (the probe's own entry) both fail with a
 *   `TypeError` thrown by `dsh-app-boot`. Today that is alpha's
 *   `0.2.2-alpha.2` as npm installs it (cordis `4.0.6-alpha.2`).
 * - Google thinking levels are pi's to send. A host whose pi's own
 *   exported predicate (`usesGoogleThinkingLevel`, `api/google-shared`) does
 *   not name the level-only Google model (in either plane's catalog) sends it
 *   a budget, which the gateway refuses: today the rc channel's floor, pi
 *   1.1.0, the desktop app's pi.
 *
 * One known defect is recorded as a `[KNOWN_DEFECT]` row, detected the same
 * way: on a host whose `internal/config` waterfall hands its listeners the
 * fiber (`claimCannotEngage`, read from the contract the probe saw the host
 * dispatch; alpha's `npm` cell today, cordis `4.0.6-alpha.2`), the route
 * claim does not engage, so that row asserts that pi-ai serves both planes
 * and that Settings' fetch answers pi's own list with nothing appended, and
 * every row that needs the claim (the plane-provider, registry, listing,
 * per-model, Gemini-level, Settings-graft, save and Settings fetch rows) skips
 * with `CLAIM_SKIP`. The save rows also skip where the host cannot save at all.
 *
 * `DSH_HOST_PROBE_COPY` names a file to keep the probe's JSON in, for the CI
 * artifact; it is written whenever the probe wrote one, a failed run included.
 * `pnpm` must be on `PATH`, and `pnpm run build` must have run.
 * The keys the profile names are DUMMY values written to the temporary
 * credentials store, so every turn reaches the probe's 401 and nothing real is
 * ever sent.
 *
 * @module test/e2e/host-binary.e2e
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  declaredRanges,
  FAMILY_DECLARERS,
  floorOf,
  REGISTRY_PACKAGES,
} from "../../scripts/host-drift.ts";
import {
  CHANNELS,
  floorOverrides,
  HOST_VERSIONS,
} from "../support/host-versions.ts";
import {
  CHARACTERIZED_MODELS,
  CHARACTERIZED_PROFILE,
  type HostCell,
  PI_AI_PACKAGE,
  type Plane,
  PLANES,
  S0_TODAY_BY_CELL,
  SAVE_CANDIDATE,
  ZEN_UNDESCRIBED,
} from "../support/host.ts";
import {
  isServableSdk,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
} from "../support/src.ts";

const ENABLED = process.env.DSH_HOST_E2E === "1";
const PREFIX = process.env.DSH_HOST_PREFIX ?? "";
const CELL = process.env.DSH_HOST_PI_CELL ?? "npm";
if (CELL !== "npm" && CELL !== "floor") {
  throw new Error(`DSH_HOST_PI_CELL=${CELL} names no cell; use npm or floor`);
}
/** The channel the prefix holds (`DSH_CHANNEL`, read by `host-versions.ts`). */
const CHANNEL = HOST_VERSIONS.channel;
const RECORD = CHANNELS[CHANNEL];
/** The host cell whose rows this run asserts. */
const ROWS_CELL: HostCell = CELL === "floor" ? `${CHANNEL}-floor` : "newest";
const ROWS = S0_TODAY_BY_CELL[ROWS_CELL];
/** The pi that cell's rows were measured on. */
const ROWS_PI = CELL === "floor" ? RECORD.piFloor : RECORD.pi;
/**
 * Whether the prefix's pi is the one the rows were measured on; set in
 * `beforeAll`, false for an npm-resolved pi newer than the channel record.
 */
let rowsHold = false;
/** The cordis the prefix resolved, for the HOST_LIMITATION row's message. */
let cordisVersion = "";
/** The Go plane's Google model the gateway serves by thinking level only (the measured case). */
const GEMINI_LEVEL_ID = "gemini-4-argon";
/**
 * Whether the prefix's own pi sends {@link GEMINI_LEVEL_ID} by thinking level;
 * set in `beforeAll` by {@link piNamesLevelModel}.
 */
let piSendsArgonLevels = false;

/**
 * Whether the prefix's pi sends `id` by Google thinking level, asked of pi's
 * own exported rule (`usesGoogleThinkingLevel`, `api/google-shared`, through
 * pi's `./api/*` export): the feature detection D26 asks for, never a version
 * compare.
 *
 * @param piRoot - the prefix's pi package root.
 * @param id - the model id.
 * @returns pi's own answer, or `false` when pi exports no such rule.
 */
const piNamesLevelModel = async (
  piRoot: string,
  id: string
): Promise<boolean> => {
  const manifest = JSON.parse(
    readFileSync(join(piRoot, "package.json"), "utf8")
  ) as { exports?: Record<string, string | { import?: string }> };
  const target = manifest.exports?.["./api/*"];
  const pattern = typeof target === "string" ? target : target?.import;
  if (pattern === undefined) {
    return false;
  }
  const shared = (await import(
    pathToFileURL(join(piRoot, pattern.replace("*", "google-shared"))).href
  )) as { usesGoogleThinkingLevel?: (model: { id: string }) => boolean };
  return shared.usesGoogleThinkingLevel?.({ id }) === true;
};

/**
 * Whether `version` satisfies a caret range `^x.y.z` (x >= 1): the same
 * major, and not below the floor. The bridge declares nothing else.
 */
const satisfiesCaret = (version: string, range: string): boolean => {
  const parse = (text: string): number[] =>
    text.replace(/^\^/u, "").split(".").map(Number);
  const [major, minor, patch] = parse(version);
  const [floorMajor, floorMinor, floorPatch] = parse(range);
  if (major !== floorMajor) {
    return false;
  }
  return (
    (minor ?? 0) * 1e6 + (patch ?? 0) >=
    (floorMinor ?? 0) * 1e6 + (floorPatch ?? 0)
  );
};
const BOOT_DEADLINE_MS = 180_000;
/** Each `dsh plugin install` (a blocking `spawnSync`). */
const INSTALL_DEADLINE_MS = 120_000;
/**
 * The hook's budget, derived from the deadlines it actually runs — two installs
 * and a boot — so every failure path reaches its own message and the probe
 * copy before vitest's hook timeout can fire. `spawnSync` blocks the worker, so
 * the hook timer cannot interrupt an install; it can only fire during the boot
 * wait, which is the window where the child is live and the artifact matters.
 */
const HOOK_BUDGET_MS = 2 * INSTALL_DEADLINE_MS + BOOT_DEADLINE_MS + 30_000;
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE_BUNDLE = join(CHECKOUT, "test", "e2e", "host");

/** What the probe writes (test/e2e/host/probe-plugin.mjs). */
interface ProbeOutput {
  readonly fatal?: string;
  readonly fetchInnermost: boolean;
  readonly planesSettled: boolean;
  readonly piLoaded: {
    fromHostPrefix: boolean;
    path: string | null;
    version: string;
  } | null;
  readonly providers: string[];
  readonly registryRoutes: string[];
  readonly owners: Record<string, string>;
  readonly configurable: {
    provider: string;
    settingsNs: string;
    error?: string;
  }[];
  readonly listModels: Record<string, unknown>;
  readonly listModelsAfter: Record<string, unknown>;
  readonly modelInfo: Record<
    string,
    { context: number; efforts: string[] } | { error: string }
  >;
  readonly callConfig: Record<string, string>;
  readonly dispatch: Record<string, { sent: string[]; finish: string }>;
  /** Each turn's Google `generationConfig.thinkingConfig`, by `route/model`. */
  readonly thinking?: Record<string, Record<string, unknown>[]>;
  readonly describe: { user: string[]; value: string[] } | undefined;
  readonly describeEntries: Record<
    string,
    { apiKeyEnv?: string; models: string[] } | null
  >;
  readonly modelsJoin: Record<
    string,
    { configured: boolean; apiKeyEnv?: string }
  >;
  readonly savedInFile?: boolean;
  /**
   * The contract the host's `internal/config` waterfall speaks, as one of its
   * dispatches showed it (`null` when none was seen): `"config"` hands a
   * listener the config, `"fiber"` hands it the fiber.
   */
  readonly configHook: "config" | "fiber" | null;
  readonly saveBlocked: { id: string } & EditVerdict;
  /** The control: an edit of the probe's own entry, made after the saves. */
  readonly control?: EditVerdict;
  readonly saveCleared?: { dropped: string[] } & EditVerdict;
  readonly save: { id: string } & EditVerdict;
  readonly afterSave?: {
    callConfig: string;
    dispatch: { sent: string[]; finish: string };
    listed: unknown;
  };
  /** Settings → Models → Fetch per plane, through the gateway's Remote face. */
  readonly discovery: Record<
    string,
    | { ids: string[]; fields: string[]; undefinedFields: string[] }
    | { error: { code?: string; message: string } }
  >;
}

/**
 * One config-editor edit's answer. A rejection names the error's class and
 * the package whose code threw it, which is how a failure inside the host's
 * own code is told apart from a verdict pi-ai's checks reached.
 */
interface EditVerdict {
  readonly accepted?: true;
  readonly errorName?: string;
  readonly rejected?: string;
  readonly thrownBy?: string;
}

/**
 * Whether an edit failed the way the host's own save path fails: a TypeError
 * thrown by `@deepseek-ai/dsh-app-boot`, a package this plugin registers no
 * listener on. Measured on the alpha channel's npm install of
 * `0.2.2-alpha.2`: its `dsh-app-boot` registers an `internal/update` listener
 * in the old call shape (`(config, noSave, next)`), while the cordis its `~`
 * range now resolves (`4.0.6-alpha.2`) calls the new one, so the save throws
 * `next is not a function` there.
 */
const hostListenerFailed = (verdict: EditVerdict | undefined): boolean =>
  verdict?.errorName === "TypeError" &&
  verdict.thrownBy === "@deepseek-ai/dsh-app-boot";

/**
 * Whether the host's `internal/config` waterfall hands its listeners the fiber
 * and reads the config from `next()`: cordis `4.0.6-alpha.2`'s contract, which
 * npm resolves for `alpha` `0.2.2-alpha.2` today and which `0.2.2-alpha.3`
 * requires. The route claim speaks the earlier contract (the config, with the
 * fiber as `this`), so on such a host it does not engage and pi-ai serves the
 * planes. Read from what the host dispatched, never from a version.
 */
const claimCannotEngage = (probe: ProbeOutput): boolean =>
  probe.configHook === "fiber";

/** The reason the claim-dependent rows skip on such a host. */
const CLAIM_SKIP =
  "KNOWN_DEFECT: the host's internal/config waterfall hands listeners the fiber (cordis 4.0.6-alpha.2), a contract the route claim does not speak yet";

/**
 * Whether the host cannot save ANY config edit, whoever makes it: the plane
 * edit failed in the host's own code, and so did the control — an edit of the
 * probe's own entry, which no plugin's listener reads — with the same error.
 * A failure of the plane edit alone is about the plane, and the save rows
 * report it. Read from what the edits answered, never from a version, so a
 * host that fixes it reads false the day it ships (D26).
 */
const hostCannotSave = (probe: ProbeOutput): boolean =>
  hostListenerFailed(probe.saveBlocked) &&
  hostListenerFailed(probe.control) &&
  probe.control?.rejected === probe.saveBlocked.rejected;

/** The Remote's five `LlmDiscoveredModel` fields. */
const REMOTE_FIELDS = [
  "contextWindow",
  "id",
  "inputModalities",
  "maxTokens",
  "name",
];

/** The plane's servable catalog ids, in catalog order, from this checkout. */
const servable = (plane: Plane): string[] =>
  (plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG)
    .filter((spec) => isServableSdk(spec.provider_npm))
    .map((spec) => spec.id);

/**
 * pi's own ids for each plane, once each, from the PREFIX's pi (the one the
 * host answers Settings' fetch from); set in `beforeAll` by
 * {@link prefixPiIds}, `undefined` when that pi exports no builtin list.
 */
let piIdsByPlane: Record<string, string[]> | undefined;

/**
 * The prefix pi's own ids per plane, read through pi's own exported
 * `getBuiltinModels` (`./providers/all`), so the order row holds in every cell
 * rather than only where the checkout's pi is the host's.
 *
 * @param piRoot - the prefix's pi package root.
 * @returns each plane's ids once each, or `undefined` when pi exports no such list.
 */
const prefixPiIds = async (
  piRoot: string
): Promise<Record<string, string[]> | undefined> => {
  const manifest = JSON.parse(
    readFileSync(join(piRoot, "package.json"), "utf8")
  ) as { exports?: Record<string, string | { import?: string }> };
  const target =
    manifest.exports?.["./providers/all"] ??
    manifest.exports?.["./providers/*"];
  const entry = typeof target === "string" ? target : target?.import;
  if (entry === undefined) {
    return undefined;
  }
  const all = (await import(
    pathToFileURL(join(piRoot, entry.replace("*", "all"))).href
  )) as {
    getBuiltinModels?: (provider: string) => readonly { id: string }[];
  };
  const read = all.getBuiltinModels;
  if (read === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    PLANES.map((plane) => [
      plane,
      [...new Set(read(plane).map((model) => model.id))],
    ])
  );
};

/** The ids Settings' fetch offered on a plane; fails by name on an error. */
const fetchedIds = (plane: Plane): string[] => {
  const answered = out.discovery[plane];
  expect(answered, plane).toHaveProperty("ids");
  return answered !== undefined && "ids" in answered ? answered.ids : [];
};

/** The entries of a directory, or none when it cannot be read. */
const entriesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
};

/**
 * Every `package.json` of pi under a `node_modules` tree, at any depth: the
 * same set as CI's `find -path '*\/@earendil-works/pi-ai/package.json'`.
 * Every package's own `node_modules` is walked, scoped ones included — pi-ai's
 * and its `@earendil-works` siblings' too, where a nested copy would hide.
 */
const piCopies = (root: string): string[] => {
  const found: string[] = [];
  const walkPackage = (dir: string, scope: string, name: string): void => {
    const manifest = join(dir, "package.json");
    if (
      scope === "@earendil-works" &&
      name === "pi-ai" &&
      existsSync(manifest)
    ) {
      found.push(manifest);
    }
    walk(join(dir, "node_modules"));
  };
  const walk = (dir: string): void => {
    for (const entry of entriesOf(dir)) {
      const full = join(dir, entry);
      if (entry.startsWith("@")) {
        for (const scoped of entriesOf(full)) {
          walkPackage(join(full, scoped), entry, scoped);
        }
      } else {
        walkPackage(full, "", entry);
      }
    }
  };
  walk(root);
  return found;
};

/**
 * How the host process ended. `timedOut` is set only by this file's own
 * deadline timer, so a signal the test did not send (a V8 abort, the runner's
 * OOM killer) never reads as a timeout.
 */
interface RunEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Why the run failed, from how it ended and what it left behind, for the
 * failure message: the real cause first, so a timeout never reads as an exit
 * code, a crash never reads as a timeout, and a complete result never reads
 * as an unreadable one.
 *
 * @param end - how the process ended.
 * @param written - the probe file's text, if it was written.
 * @param parsed - that text parsed, if it parsed.
 * @returns one sentence naming the cause.
 */
const whyRunFailed = (
  end: RunEnd,
  written: string | undefined,
  parsed: ProbeOutput | undefined
): string => {
  let how = `exited ${String(end.code)}`;
  if (end.timedOut) {
    how = `timed out after ${BOOT_DEADLINE_MS} ms and was killed`;
  } else if (end.signal !== null) {
    how = `was killed by ${end.signal}`;
  }
  if (parsed?.fatal !== undefined) {
    return `the host ${how}, with the probe's fatal error: ${parsed.fatal}`;
  }
  let left = "after writing a complete probe result (see the artifact)";
  if (written === undefined) {
    left = "without a probe result";
  } else if (parsed === undefined) {
    left = "with an unreadable probe result";
  }
  return `the host ${how}, ${left}`;
};

/** POSIX separators, so a `link:` spec reads the same on every runner. */
const posix = (path: string): string => path.split(sep).join("/");

let home = "";
let out: ProbeOutput;
/** The version of the host prefix's own pi. */
let hostPiVersion = "";
/** The booted host, kept so `afterAll` can stop it before removing HOME. */
let child: ChildProcess | undefined;

describe.skipIf(!ENABLED)("e2e · the published host binary (dsh)", () => {
  beforeAll(async () => {
    if (
      PREFIX.length === 0 ||
      !existsSync(join(PREFIX, "node_modules", "@deepseek-ai", "dsh"))
    ) {
      throw new Error(
        "DSH_HOST_PREFIX must name a directory whose node_modules/@deepseek-ai/dsh is the installed host"
      );
    }
    const bin = join(
      PREFIX,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js"
    );
    const piRoot = join(PREFIX, "node_modules", "@earendil-works", "pi-ai");
    const piVersion = (
      JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    hostPiVersion = piVersion;
    const dshVersion = (
      JSON.parse(
        readFileSync(
          join(PREFIX, "node_modules", "@deepseek-ai", "dsh", "package.json"),
          "utf8"
        )
      ) as { version: string }
    ).version;
    console.info(
      `[e2e-host] ${CHANNEL} · ${CELL}: dsh ${dshVersion}, pi ${piVersion} (rows: ${ROWS_CELL}, measured on pi ${ROWS_PI})`
    );
    expect(dshVersion, "the prefix holds another channel's host").toBe(
      RECORD.dsh
    );
    piSendsArgonLevels = await piNamesLevelModel(piRoot, GEMINI_LEVEL_ID);
    piIdsByPlane = await prefixPiIds(piRoot);
    expect(piCopies(join(PREFIX, "node_modules"))).toHaveLength(1);
    expect(
      satisfiesCaret(piVersion, RECORD.piRange),
      `pi ${piVersion} is outside the bridge's ${RECORD.piRange}`
    ).toBe(true);
    const installedVersion = (name: string): string =>
      (
        JSON.parse(
          readFileSync(
            join(PREFIX, "node_modules", ...name.split("/"), "package.json"),
            "utf8"
          )
        ) as { version: string }
      ).version;
    const installedManifest = (name: string) =>
      JSON.parse(
        readFileSync(
          join(PREFIX, "node_modules", ...name.split("/"), "package.json"),
          "utf8"
        )
      ) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        version: string;
      };
    if (CELL === "floor") {
      expect(piVersion).toBe(RECORD.piFloor);
      // npm applied every override: the floor cell is the tree the desktop
      // app ships, not whatever the host's `~` ranges resolve today.
      for (const [name, version] of Object.entries(floorOverrides(RECORD))) {
        expect(installedVersion(name), name).toBe(version);
      }
    }
    cordisVersion = installedVersion("@deepseek-ai/cordis");
    // The record's family is the floor of the range the installed published
    // package declares (cosmokit's declarer, cordis, only where the record's
    // cordis is the one installed): an independent witness in either cell.
    const witnessed: string[] = [];
    for (const { declarer, field, name } of FAMILY_DECLARERS) {
      const manifest = installedManifest(REGISTRY_PACKAGES[declarer]);
      if (declarer === "cordis" && manifest.version !== RECORD.cordis) {
        continue;
      }
      expect(
        floorOf(declaredRanges(manifest)[name] ?? ""),
        `${REGISTRY_PACKAGES[declarer]}@${manifest.version} declares ${name}`
      ).toBe(RECORD[field]);
      witnessed.push(field);
    }
    expect(witnessed).toContain("timer");
    rowsHold = piVersion === ROWS_PI;
    if (!rowsHold) {
      console.warn(
        `[e2e-host] npm resolved pi ${piVersion}, not the ${CHANNEL} record's ${RECORD.pi}: the rows that depend on which ids pi describes are skipped (the nightly drift report names it)`
      );
    }
    expect(existsSync(join(CHECKOUT, "lib", "index.mjs"))).toBe(true);

    home = mkdtempSync(join(tmpdir(), "dsh-host-e2e-"));
    const dshHome = join(home, ".dsh");
    const profileDir = join(dshHome, "profiles", "e2e");
    // No inherited npm_config_* and no OPENCODE_* key: the run sees only what
    // this file gives it.
    const env = {
      CI: "1",
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
      HOME: home,
      PATH: process.env.PATH ?? "",
    };
    const dsh = (args: string[]) => {
      const run = spawnSync(process.execPath, [bin, ...args], {
        cwd: home,
        encoding: "utf8",
        env,
        timeout: INSTALL_DEADLINE_MS,
      });
      if (run.status !== 0) {
        // A spawn error, a timeout and a signal all leave `status` null; name
        // the one that happened rather than "exited null".
        let how = `exited ${String(run.status)}`;
        if (run.error !== undefined) {
          how = `failed: ${run.error.message}`;
        } else if (run.signal !== null) {
          how = `was killed by ${run.signal}`;
        }
        throw new Error(
          `dsh ${args.join(" ")} ${how}:\n${(run.stderr ?? "").slice(-2000)}`
        );
      }
    };
    // Initializes the profile, then installs the two linked bundles.
    dsh(["plugin", "--profile", "e2e", "install"]);
    writeFileSync(
      join(profileDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "dsh-host-probe": `link:${posix(relative(profileDir, PROBE_BUNDLE))}`,
            "dsh-opencode-patch": `link:${posix(relative(profileDir, CHECKOUT))}`,
          },
          dsh: {
            profile: {
              bundles: [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "dsh-opencode-patch",
                "dsh-host-probe",
              ],
            },
          },
          name: "dsh-profile-e2e",
          private: true,
        },
        null,
        2
      )}\n`
    );
    dsh(["plugin", "--profile", "e2e", "install"]);
    // The characterization profile, as JSON text (valid YAML).
    writeFileSync(
      join(profileDir, "cordis.patch.yml"),
      `${JSON.stringify([{ config: { providers: CHARACTERIZED_PROFILE }, id: "llm-pi-ai" }], null, 2)}\n`
    );
    // Dummy keys in the credentials store, never the environment: the plugin
    // reads the environment directly, and the in-process rows were measured
    // with the keys in the credentials service only.
    mkdirSync(dshHome, { recursive: true });
    writeFileSync(
      join(dshHome, ".credentials.yaml"),
      "version: 1\nrefs:\n  OPENCODE_API_KEY: probe-zen-not-a-key\n  OPENCODE_GO_API_KEY: probe-go-not-a-key\n",
      { mode: 0o600 }
    );

    const probeOut = join(home, "probe.json");
    const host = spawn(
      process.execPath,
      [bin, "--profile", "e2e", "--no-open", "--port", "0"],
      {
        cwd: home,
        env: {
          ...env,
          PROBE_HOST_PREFIX: PREFIX,
          PROBE_MODELS: JSON.stringify(CHARACTERIZED_MODELS),
          PROBE_OUT: probeOut,
          PROBE_PI_PACKAGE: PI_AI_PACKAGE,
          PROBE_PLANES: JSON.stringify(PLANES),
          PROBE_SAVE: SAVE_CANDIDATE,
          PROBE_SAVE_DROP: JSON.stringify(ZEN_UNDESCRIBED),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child = host;
    let stderr = "";
    host.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    host.stdout.resume();
    const end = await new Promise<RunEnd>((resolve) => {
      const timer = setTimeout(() => {
        host.kill("SIGKILL");
        resolve({ code: null, signal: "SIGKILL", timedOut: true });
      }, BOOT_DEADLINE_MS);
      host.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
    // Whatever the probe wrote is kept BEFORE the exit code is judged: a
    // failed run is the one whose artifact matters. The probe writes URLs,
    // model ids, verdicts and host error messages (cut to 500 characters) —
    // never a header or a key value.
    const written = existsSync(probeOut)
      ? readFileSync(probeOut, "utf8")
      : undefined;
    const copy = process.env.DSH_HOST_PROBE_COPY ?? "";
    if (written !== undefined && copy.length > 0) {
      writeFileSync(copy, written);
    }
    let parsed: ProbeOutput | undefined;
    try {
      parsed =
        written === undefined
          ? undefined
          : (JSON.parse(written) as ProbeOutput);
    } catch {
      parsed = undefined;
    }
    if (end.code !== 0 || parsed === undefined || parsed.fatal !== undefined) {
      throw new Error(
        `${whyRunFailed(end, written, parsed)}\n--- stderr (tail) ---\n${stderr.slice(-2000)}`
      );
    }
    out = parsed;
    console.info(`[e2e-host] probe output:\n${JSON.stringify(out, null, 2)}`);
  }, HOOK_BUDGET_MS);

  afterAll(() => {
    // A hook that failed before the boot settled leaves the host running;
    // stop it before its HOME goes.
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGKILL");
    }
    if (home.length > 0) {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it("measured with the probe innermost and both planes settled on the plugin's adapter", (context) => {
    expect(out.fatal).toBeUndefined();
    expect(out.fetchInnermost).toBe(true);
    // Known answer for the detector below: some dispatch was observed.
    expect(out.configHook).not.toBeNull();
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.planesSettled).toBe(true);
  });

  it(`[KNOWN_DEFECT] ${CHANNEL} ${RECORD.dsh} (${CELL} cell), on a host whose internal/config waterfall hands listeners the fiber: the route claim does not engage, pi-ai serves both planes, and Settings' fetch answers pi's own list`, (context) => {
    context.skip(
      !claimCannotEngage(out),
      "this host's internal/config waterfall hands listeners the config"
    );
    // Recorded so the phase that bumps alpha to a release requiring this
    // cordis adopts the contract (feature-detected) and flips this row.
    console.warn(
      `[e2e-host] ${CHANNEL} · ${CELL}: KNOWN_DEFECT — cordis ${cordisVersion} hands internal/config listeners the fiber; the route claim did not engage`
    );
    expect(out.planesSettled).toBe(false);
    expect(out.owners.opencode).toBe("PiAiAdapter");
    expect(out.owners["opencode-go"]).toBe("PiAiAdapter");
    // The claim reads as not engaged once its mount settles, so the fetch is
    // the enrich-only merge: pi's own ids and nothing appended, since pi-ai,
    // which serves the planes here, refuses at save an id it does not list.
    context.skip(
      piIdsByPlane === undefined,
      "the prefix's pi exports no getBuiltinModels under ./providers/all"
    );
    for (const plane of PLANES) {
      expect(fetchedIds(plane), plane).toEqual(piIdsByPlane?.[plane] ?? []);
    }
  });

  it("the plane provider is built from the host's own pi, not the linked checkout's (both cells)", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    // The plugin is installed as a `link:` to this checkout, whose own
    // development install holds a pi too; the plugin resolves the wrapper
    // from the loader's base URL, so it reaches the host prefix's copy — the
    // npm cell's pi included.
    expect(out.piLoaded).toEqual({
      fromHostPrefix: true,
      path: "node_modules/@earendil-works/pi-ai",
      version: hostPiVersion,
    });
  });

  it("[BASELINE] registry: both planes are the plugin's PlaneAdapter, no hidden route exists, and Settings addresses the planes under pi-ai's namespace with no error (D13)", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.providers).toEqual(
      expect.arrayContaining(["opencode", "opencode-go"])
    );
    expect(out.owners.opencode).toBe("PlaneAdapter");
    expect(out.owners["opencode-go"]).toBe("PlaneAdapter");
    expect(
      out.registryRoutes.filter((route) =>
        /^opencode-(?:responses|anthropic|google|go-)/u.test(route)
      )
    ).toEqual([]);
    for (const plane of PLANES) {
      const entry = out.configurable.find((row) => row.provider === plane);
      expect(entry).toMatchObject({ provider: plane, settingsNs: "llm-pi-ai" });
      expect(entry?.error).toBeUndefined();
    }
  });

  it("[BASELINE] listing before any turn: every declared id is listed (D21)", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.listModels).toEqual(ROWS.listingBeforeTurn);
  });

  it("[BASELINE] listing after a turn on each plane: every declared id is still listed (G1)", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.listModelsAfter).toEqual(ROWS.listingAfterTurn);
  });

  // A pi newer than the channel record can still move a model's metadata
  // where the catalog states none, so these hold for the pi the cell's rows
  // were measured on; such a run's probe JSON is the record.
  it("resolveModelInfo, resolveCallConfig and the wire match the in-process rows of this cell", (context) => {
    if (!rowsHold) {
      context.skip();
    }
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    for (const [key, row] of Object.entries(ROWS.rows)) {
      expect(out.modelInfo[key], key).toEqual(row.info);
      expect(out.callConfig[key], key).toBe(row.callConfig);
      expect(out.dispatch[key], key).toEqual({
        finish: row.finish,
        sent: row.sent,
      });
    }
    expect(out.dispatch[`opencode-go/${GEMINI_LEVEL_ID}`]?.sent).toEqual([
      `https://opencode.ai/inference/go/google/v1beta/models/${GEMINI_LEVEL_ID}:streamGenerateContent?alt=sse`,
    ]);
    expect(out.callConfig[`opencode-go/${GEMINI_LEVEL_ID}`]).toBe("ok");
  });

  // The probe's turn chooses no effort, so a model pi sends by level is sent
  // the level pi falls back to, never a budget. Which ids pi sends by level is
  // pi's own rule (`usesGoogleThinkingLevel`); the live 400 was a
  // `thinkingBudget` here.
  it("[BASELINE] the Go Gemini level model is sent a thinking level and no thinkingBudget, through the shipped bundle, where the host's pi names it", (context) => {
    if (!piSendsArgonLevels) {
      context.skip();
    }
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    const sent = out.thinking?.[`opencode-go/${GEMINI_LEVEL_ID}`] ?? [];
    expect(sent.length).toBeGreaterThan(0);
    for (const config of sent) {
      expect(config).toEqual({ thinkingLevel: "LOW" });
    }
  });

  it(`[HOST_LIMITATION] ${CHANNEL} ${RECORD.dsh} (${CELL} cell): the host's pi sends the Go Gemini level model a thinking budget (reported upstream, D26)`, (context) => {
    if (piSendsArgonLevels) {
      context.skip();
    }
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    // Recorded, not fixed here: pi's own pattern does not name the id, so pi
    // builds a budget for it, which the gateway refuses. The plugin sends what
    // the host's pi builds; bumping pi is the host's fix.
    console.warn(
      `[e2e-host] ${CHANNEL} · ${CELL}: HOST_LIMITATION — pi ${hostPiVersion} sends ${GEMINI_LEVEL_ID} a thinking budget, not a level`
    );
    const sent = out.thinking?.[`opencode-go/${GEMINI_LEVEL_ID}`] ?? [];
    expect(sent.length).toBeGreaterThan(0);
    for (const config of sent) {
      expect(config).not.toHaveProperty("thinkingLevel");
    }
  });

  it("[BASELINE] the settings page reads every plane the profile declares", () => {
    expect(out.describe?.value.toSorted()).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
    ]);
  });

  it(`[HOST_LIMITATION] ${CHANNEL} ${RECORD.dsh} (${CELL} cell): no config-editor save succeeds, because the host's own code throws (reported upstream, D26)`, (context) => {
    if (!hostCannotSave(out)) {
      // This host saves (or fails only the plane edit, which the save rows
      // report): the limitation is absent here, so there is nothing to record.
      context.skip();
    }
    // Recorded, not fixed here: the host's own code cannot run, so no edit
    // saves, whoever makes it. The save rows below skip on this host. What is
    // asserted is that the failure is that one and only that one: every edit
    // the probe made failed the same way, inside the host's code.
    console.warn(
      `[e2e-host] ${CHANNEL} · ${CELL}: HOST_LIMITATION — the host's own ${String(out.saveBlocked.thrownBy)} throws under cordis ${cordisVersion} on every save, the control included (${String(out.saveBlocked.rejected)}); the save rows are skipped`
    );
    expect(hostListenerFailed(out.saveCleared)).toBe(true);
    expect(hostListenerFailed(out.save)).toBe(true);
    expect(out.afterSave).toBeUndefined();
  });

  it("[BASELINE] the control edit (the probe's own entry, which no plugin reads) saves", (context) => {
    if (hostCannotSave(out)) {
      context.skip();
    }
    // The known answer the HOST_LIMITATION detector rests on: where the host
    // can save, an edit the plugin cannot reach is accepted.
    expect(out.control).toEqual({ accepted: true });
  });

  it("[BASELINE] the Settings graft shows each plane's own entry, and the Models page reads both planes configured under their apiKeyEnv (D18)", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.describeEntries).toEqual({
      opencode: {
        apiKeyEnv: "OPENCODE_API_KEY",
        models: CHARACTERIZED_MODELS.opencode,
      },
      "opencode-go": {
        apiKeyEnv: "OPENCODE_GO_API_KEY",
        models: CHARACTERIZED_MODELS["opencode-go"],
      },
    });
    expect(out.modelsJoin.opencode).toEqual({
      apiKeyEnv: "OPENCODE_API_KEY",
      configured: true,
    });
    expect(out.modelsJoin["opencode-go"]).toEqual({
      apiKeyEnv: "OPENCODE_GO_API_KEY",
      configured: true,
    });
  });

  it("[BASELINE] a stored gap id blocks no save: the catalog-unknown id is accepted on the first try (D15)", (context) => {
    if (hostCannotSave(out)) {
      context.skip();
    }
    // D15 is the route claim's: with pi-ai serving the planes, pi-ai's own
    // strict check refuses the stored gap id, so a host that saves but where
    // the claim cannot engage skips these as the KNOWN_DEFECT, not as a
    // D15 failure.
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.saveBlocked).toEqual({ accepted: true, id: SAVE_CANDIDATE });
    expect(out.saveCleared).toBeUndefined();
  });

  it("[BASELINE] a catalog-unknown id saves to the file, is listed, validates and is sent as completions on the modern base (D15, D16)", (context) => {
    if (hostCannotSave(out)) {
      context.skip();
    }
    // D15 is the route claim's: with pi-ai serving the planes, pi-ai's own
    // strict check refuses the stored gap id, so a host that saves but where
    // the claim cannot engage skips these as the KNOWN_DEFECT, not as a
    // D15 failure.
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    expect(out.save).toEqual({ accepted: true, id: SAVE_CANDIDATE });
    expect(out.savedInFile).toBe(true);
    expect(out.afterSave?.listed).toContain(SAVE_CANDIDATE);
    expect(out.afterSave?.callConfig).toBe("ok");
    expect(out.afterSave?.dispatch).toEqual({
      finish: "AUTH",
      sent: ["https://opencode.ai/inference/openai/v1/chat/completions"],
    });
  });

  it("[BASELINE] Settings' fetch on each plane offers the whole servable catalog, each id once, in the Remote's row shape (D3)", (context) => {
    // The wrapper appends the catalog only while the route claim has
    // engaged; where it cannot, the KNOWN_DEFECT row above asserts the
    // enrich-only answer instead.
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    for (const plane of PLANES) {
      const ids = fetchedIds(plane);
      expect(new Set(ids).size, plane).toBe(ids.length);
      expect(ids, plane).toEqual(expect.arrayContaining(servable(plane)));
      const answered = out.discovery[plane];
      const fields =
        answered !== undefined && "fields" in answered ? answered.fields : [];
      expect(fields, plane).toContain("id");
      expect(REMOTE_FIELDS, plane).toEqual(expect.arrayContaining(fields));
      // No key is present with an `undefined` value: the codec would hide it.
      expect(
        answered !== undefined && "undefinedFields" in answered
          ? answered.undefinedFields
          : undefined,
        plane
      ).toEqual([]);
    }
    expect(fetchedIds("opencode")).toContain("gpt-5.3-codex-spark");
    expect(fetchedIds("opencode-go")).toContain("minimax-m3.1-flash");
    expect(fetchedIds("opencode-go")).toContain(GEMINI_LEVEL_ID);
  });

  // The order is read against the list the PREFIX's own pi exports, so it
  // holds in every cell where the route claim engages, a newer pi than the
  // record's included.
  it("[BASELINE] Settings' fetch answers the host pi's own list first, then the catalog models that pi lacks", (context) => {
    context.skip(claimCannotEngage(out), CLAIM_SKIP);
    context.skip(
      piIdsByPlane === undefined,
      "the prefix's pi exports no getBuiltinModels under ./providers/all"
    );
    for (const plane of PLANES) {
      const pi = piIdsByPlane?.[plane] ?? [];
      expect(fetchedIds(plane), plane).toEqual([
        ...pi,
        ...servable(plane).filter((id) => !pi.includes(id)),
      ]);
    }
  });
});
