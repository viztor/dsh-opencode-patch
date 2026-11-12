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
 * The assertions are TODAY's behaviour, read from `S0_TODAY_BY_CELL` for the
 * cell this run installed, the same tables the in-process characterization
 * pins, so the binary and the harness cannot drift
 * apart unnoticed. P-R1 flips the rows its PR names. The loader starts rows in
 * parallel, so which of pi-ai and the plugin applies first is a race. The rows
 * depend on whether the plugin's adapter decoration wrapped pi-ai's plane
 * adapter, so the probe records that and the order it implies
 * (`inferredOrder`), and the per-model rows follow it (`todayRowsFor`) rather
 * than pinning a 70 ms margin.
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
 *   bridge's range, but the rows that depend on which ids pi describes (the
 *   keyed listing and the per-model rows) are skipped with a warning: the
 *   nightly drift report names the new pi, and its probe JSON is the record.
 *   The save rows do not depend on which pi resolved; they assume pi lacks at
 *   least one of `ZEN_UNDESCRIBED` and still describes every other declared
 *   Zen id, so a pi that learns all of them or retires a declared id turns
 *   them red by design — triage that as a pi change first.
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
 * checks it. Measured 2026-11-12, every cell's installed cordis is its
 * record's, so cosmokit is checked in all four.
 *
 * Only the `npm` cell lets cordis float, as the published host's `~` ranges
 * do for a user. Where what it resolved leaves the host unable to run its own
 * save path, the run records a `[HOST_LIMITATION]` row and skips the save
 * rows. That is detected from what the host answered, never from a version:
 * the plane edit AND a control edit no plugin's listener reads (the probe's
 * own entry) both fail with a `TypeError` thrown by `dsh-app-boot`. It was
 * alpha's `0.2.2-alpha.2` as npm installed it (cordis `4.0.6-alpha.2`); on
 * `0.2.2-alpha.3` and `0.2.2-rc.2` every cell, `npm` and `floor`, saves the
 * control edit (measured 2026-11-12), so the row skips and the save rows run.
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
import { fileURLToPath } from "node:url";

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
  type ApplyOrder,
  CHARACTERIZED_MODELS,
  CHARACTERIZED_PROFILE,
  type HostCell,
  PI_AI_PACKAGE,
  S0_TODAY_BY_CELL,
  SAVE_BLOCKED_BY_ANY_UNDESCRIBED,
  SAVE_CANDIDATE,
  todayRowsFor,
  ZEN_UNDESCRIBED,
} from "../support/host.ts";
import { INTERNAL_ROUTES } from "../support/src.ts";

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
  readonly routesSettled: boolean;
  readonly planeAdapterDecorated: boolean;
  /** Inferred from `planeAdapterDecorated`, not observed: see the probe. */
  readonly inferredOrder: ApplyOrder;
  readonly providers: string[];
  readonly registryRoutes: string[];
  readonly owners: Record<string, string>;
  readonly configurable: { provider: string; settingsNs: string }[];
  readonly listModels: Record<string, unknown>;
  readonly listModelsAfter: Record<string, unknown>;
  readonly modelInfo: Record<
    string,
    { context: number; efforts: string[] } | { error: string }
  >;
  readonly callConfig: Record<string, string>;
  readonly dispatch: Record<string, { sent: string[]; finish: string }>;
  readonly describe: { user: string[]; value: string[] } | undefined;
  readonly saveBlocked: { id: string } & EditVerdict;
  /** The control: an edit of the probe's own entry, made after the saves. */
  readonly control?: EditVerdict;
  readonly saveCleared?: { dropped: string[] } & EditVerdict;
  readonly save: { id: string } & EditVerdict;
  readonly afterSave?: unknown;
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
 * `0.2.2-alpha.2`: its `dsh-app-boot` registered an `internal/update`
 * listener in the old call shape (`(config, noSave, next)`), while the cordis
 * its `~` range resolved (`4.0.6-alpha.2`) calls the new one, so the save
 * threw `next is not a function` there. `0.2.2-alpha.3` and `0.2.2-rc.2`
 * register theirs in the new shape, and every cell saves.
 */
const hostListenerFailed = (verdict: EditVerdict | undefined): boolean =>
  verdict?.errorName === "TypeError" &&
  verdict.thrownBy === "@deepseek-ai/dsh-app-boot";

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
          PROBE_MODELS: JSON.stringify(CHARACTERIZED_MODELS),
          PROBE_OUT: probeOut,
          PROBE_PI_PACKAGE: PI_AI_PACKAGE,
          PROBE_ROUTES: JSON.stringify(INTERNAL_ROUTES),
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

  it("measured with the probe innermost and the hidden routes settled", () => {
    expect(out.fatal).toBeUndefined();
    expect(out.fetchInnermost).toBe(true);
    expect(out.routesSettled).toBe(true);
  });

  it("[INTENDED_CHANGE] registry: the planes are pi-ai's; the hidden routes are registered and not listed (P-R1 claims the planes)", () => {
    expect(out.providers).toEqual(
      expect.arrayContaining(["opencode", "opencode-go"])
    );
    for (const route of INTERNAL_ROUTES) {
      expect(out.providers).not.toContain(route);
      expect(out.registryRoutes).toContain(route);
    }
    expect(out.owners.opencode).toBe("PiAiAdapter");
    expect(out.owners["opencode-go"]).toBe("PiAiAdapter");
    for (const plane of ["opencode", "opencode-go"]) {
      expect(out.configurable).toContainEqual(
        expect.objectContaining({ provider: plane, settingsNs: "llm-pi-ai" })
      );
    }
  });

  it("[INTENDED_CHANGE] keyless listing: every paid model is hidden before a key is captured", () => {
    expect(out.listModels).toEqual(ROWS.keylessListing);
  });

  // These two depend on which ids pi describes, so they hold for the pi the
  // cell's rows were measured on; an npm-resolved pi newer than the channel
  // record skips them, and its probe JSON is the record.
  describe("rows that depend on which ids pi describes", () => {
    it("[KNOWN_DEFECT] keyed listing: the ids this cell's pi cannot place are missing", (context) => {
      if (!rowsHold) {
        context.skip();
      }
      expect(out.listModelsAfter).toEqual(ROWS.keyedListing);
    });

    it("resolveModelInfo, resolveCallConfig and the wire match the in-process rows of this cell, for the decoration state the probe recorded", (context) => {
      if (!rowsHold) {
        context.skip();
      }
      // The loader starts rows in parallel (F17), so whether the plugin's
      // decoration wrapped pi-ai's plane adapter is a race: measured on the
      // published binary it did not (the plugin applied about 70 ms first),
      // which is no margin to pin. So the rows follow the recorded state, and
      // `todayRowsFor` throws on a missing or unknown value.
      console.info(
        `[e2e-host] plane adapter decorated: ${String(out.planeAdapterDecorated)} (inferred order ${out.inferredOrder})`
      );
      for (const [key, row] of Object.entries(
        todayRowsFor(out.inferredOrder, ROWS_CELL)
      )) {
        expect(out.modelInfo[key], key).toEqual(row.info);
        expect(out.callConfig[key], key).toBe(row.callConfig);
        expect(out.dispatch[key], key).toEqual({
          finish: row.finish,
          sent: row.sent,
        });
      }
    });
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

  it("[KNOWN_DEFECT] a stored gap id blocks saving any new id on its plane", (context) => {
    if (hostCannotSave(out)) {
      context.skip();
    }
    // pi-ai's strict check names the FIRST stored id the installed pi cannot
    // describe. Every recorded cell's pi lacks the first of ZEN_UNDESCRIBED,
    // so it is named; a newer pi may have learned it, and then names the next
    // undescribed id — so that run asserts only that one of them blocks it.
    expect(out.saveBlocked.rejected).toMatch(
      rowsHold ? ROWS.saveBlockedByStoredGap : SAVE_BLOCKED_BY_ANY_UNDESCRIBED
    );
  });

  it("[KNOWN_DEFECT] a catalog-unknown id cannot be saved, once the plane stores no gap id", (context) => {
    if (hostCannotSave(out)) {
      context.skip();
    }
    // Clearing only ZEN_UNDESCRIBED assumes the installed pi still describes
    // the other opencode ids the profile declares. A pi newer than the record
    // asserts it too: one that retires one of them would fail here, and that
    // is a retirement worth a red run rather than a row to skip.
    expect(out.saveCleared).toEqual({
      accepted: true,
      dropped: [...ZEN_UNDESCRIBED],
    });
    expect(out.save.rejected).toMatch(ROWS.saveRejectedUnknown);
    expect(out.afterSave).toBeUndefined();
  });
});
