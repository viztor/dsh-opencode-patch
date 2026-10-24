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
 * The assertions are TODAY's behaviour, read from the same `S0_TODAY` table the
 * in-process characterization pins, so the binary and the harness cannot drift
 * apart unnoticed. P-R1 flips the rows its PR names. The loader starts rows in
 * parallel, so which of pi-ai and the plugin applies first is a race. The rows
 * depend on whether the plugin's adapter decoration wrapped pi-ai's plane
 * adapter, so the probe records that and the order it implies
 * (`inferredOrder`), and the per-model rows follow it (`todayRowsFor`) rather
 * than pinning a 70 ms margin.
 *
 * Gated: it runs only with `DSH_HOST_E2E=1`, and needs `DSH_HOST_PREFIX`, a
 * directory whose `node_modules/@deepseek-ai/dsh` is the installed host.
 * `DSH_HOST_PI_CELL=pinned` (the default) also requires the pi
 * `host-versions.ts` names, with the harness patch, and asserts every row;
 * `floating` accepts whatever pi the host resolved. It skips the rows that
 * depend on which ids pi describes (the keyed listing and the per-model rows)
 * and still asserts the save rows. Those assume the floating pi lacks at least
 * one of `ZEN_UNDESCRIBED` and still describes every other declared Zen id, so
 * a pi that learns all of them or retires a declared id turns them red by
 * design — triage a red floating run as a pi change first.
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
import { spawn, spawnSync } from "node:child_process";
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

import { HOST_VERSIONS } from "../support/host-versions.ts";
import {
  type ApplyOrder,
  CHARACTERIZED_MODELS,
  CHARACTERIZED_PROFILE,
  PI_AI_PACKAGE,
  S0_TODAY,
  SAVE_BLOCKED_BY_ANY_UNDESCRIBED,
  SAVE_CANDIDATE,
  todayRowsFor,
  ZEN_UNDESCRIBED,
} from "../support/host.ts";
import { INTERNAL_ROUTES } from "../support/src.ts";

const ENABLED = process.env.DSH_HOST_E2E === "1";
const PREFIX = process.env.DSH_HOST_PREFIX ?? "";
const CELL = process.env.DSH_HOST_PI_CELL ?? "pinned";
const PINNED = CELL === "pinned";
const BOOT_DEADLINE_MS = 180_000;
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
  readonly saveBlocked: { id: string; rejected?: string; accepted?: true };
  readonly saveCleared?: {
    dropped: string[];
    rejected?: string;
    accepted?: true;
  };
  readonly save: { id: string; rejected?: string; accepted?: true };
  readonly afterSave?: unknown;
}

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
    console.info(`[e2e-host] cell ${CELL}: pi ${piVersion}`);
    expect(piCopies(join(PREFIX, "node_modules"))).toHaveLength(1);
    if (PINNED) {
      expect(piVersion).toBe(HOST_VERSIONS.pi);
      // The harness patch is applied (the check test/host-versions.test.ts runs).
      expect(
        readFileSync(join(piRoot, "dist", "api", "pi-messages.js"), "utf8")
      ).not.toContain("parseStreamingJson(json)");
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
        timeout: BOOT_DEADLINE_MS,
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
    const child = spawn(
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
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdout.resume();
    const end = await new Promise<RunEnd>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, signal: "SIGKILL", timedOut: true });
      }, BOOT_DEADLINE_MS);
      child.on("exit", (code, signal) => {
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
  }, BOOT_DEADLINE_MS * 2);

  afterAll(() => {
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
    expect(out.listModels).toEqual(S0_TODAY.keylessListing);
  });

  // These two depend on which ids pi describes, so they are pinned for the
  // pi this repository pins; the floating cell skips them and its probe JSON
  // is the record.
  describe("rows that depend on which ids pi describes", () => {
    it.skipIf(!PINNED)(
      "[KNOWN_DEFECT] keyed listing: the gap ids are missing (pinned pi)",
      () => {
        expect(out.listModelsAfter).toEqual(S0_TODAY.keyedListing);
      }
    );

    it.skipIf(!PINNED)(
      "resolveModelInfo, resolveCallConfig and the wire match the in-process rows for the decoration state the probe recorded (pinned pi)",
      () => {
        // The loader starts rows in parallel (F17), so whether the plugin's
        // decoration wrapped pi-ai's plane adapter is a race: measured on the
        // published binary it did not (the plugin applied about 70 ms first),
        // which is no margin to pin. So the rows follow the recorded state, and
        // `todayRowsFor` throws on a missing or unknown value.
        console.info(
          `[e2e-host] plane adapter decorated: ${String(out.planeAdapterDecorated)} (inferred order ${out.inferredOrder})`
        );
        for (const [key, row] of Object.entries(
          todayRowsFor(out.inferredOrder)
        )) {
          expect(out.modelInfo[key], key).toEqual(row.info);
          expect(out.callConfig[key], key).toBe(row.callConfig);
          expect(out.dispatch[key], key).toEqual({
            finish: row.finish,
            sent: row.sent,
          });
        }
      }
    );
  });

  it("[BASELINE] the settings page reads every plane the profile declares", () => {
    expect(out.describe?.value.toSorted()).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
    ]);
  });

  it("[KNOWN_DEFECT] a stored gap id blocks saving any new id on its plane", () => {
    // pi-ai's strict check names the FIRST stored id the installed pi cannot
    // describe. The pinned pi lacks gpt-5.3-codex-spark, so it is named; a
    // floating pi may have learned it, and then names the next undescribed id
    // — so the floating cell asserts only that one of them blocks the save.
    expect(out.saveBlocked.rejected).toMatch(
      PINNED ? S0_TODAY.saveBlockedByStoredGap : SAVE_BLOCKED_BY_ANY_UNDESCRIBED
    );
  });

  it("[KNOWN_DEFECT] a catalog-unknown id cannot be saved, once the plane stores no gap id", () => {
    // Clearing only ZEN_UNDESCRIBED assumes the installed pi still describes
    // the other opencode ids the profile declares. The floating cell asserts
    // it too: a pi that retires one of them would fail here, and that is a
    // retirement worth a red nightly rather than a row to skip.
    expect(out.saveCleared).toEqual({
      accepted: true,
      dropped: [...ZEN_UNDESCRIBED],
    });
    expect(out.save.rejected).toMatch(S0_TODAY.saveRejectedUnknown);
    expect(out.afterSave).toBeUndefined();
  });
});
