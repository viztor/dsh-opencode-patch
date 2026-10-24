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
 * The assertions are the plugin's behaviour, read from the same `S0_TODAY`
 * table the in-process characterization pins, so the binary and the harness
 * cannot drift apart unnoticed. Since P-R1 the plugin owns both plane routes
 * (D13): no row depends on which of pi-ai and the plugin applies first, so the
 * per-model rows are `S0_TODAY.rows` in either order, and the listing and save
 * rows no longer depend on which ids pi describes. The Settings fetch rows (P3)
 * are checked against this checkout's servable shim catalog, and against pi's
 * own list in the pinned cell.
 *
 * Gated: it runs only with `DSH_HOST_E2E=1`, and needs `DSH_HOST_PREFIX`, a
 * directory whose `node_modules/@deepseek-ai/dsh` is the installed host.
 * `DSH_HOST_PI_CELL=pinned` (the default) also requires the pi
 * `host-versions.ts` names, with the harness patch, and asserts every row;
 * `floating` accepts whatever pi the host resolved, and skips the per-model
 * rows (a newer pi's own entry can move a model's metadata) and the Settings
 * fetch's order (pi's list first); its probe JSON is the record.
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

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOST_VERSIONS } from "../support/host-versions.ts";
import {
  CHARACTERIZED_MODELS,
  CHARACTERIZED_PROFILE,
  PI_AI_PACKAGE,
  type Plane,
  PLANES,
  S0_TODAY,
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
const CELL = process.env.DSH_HOST_PI_CELL ?? "pinned";
const PINNED = CELL === "pinned";
const BOOT_DEADLINE_MS = 180_000;
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
  readonly saveBlocked: { id: string; rejected?: string; accepted?: true };
  readonly saveCleared?: {
    dropped: string[];
    rejected?: string;
    accepted?: true;
  };
  readonly save: { id: string; rejected?: string; accepted?: true };
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

/** pi's own ids for a plane, once each, from the checkout's (pinned) pi. */
const piIds = (plane: Plane): string[] => [
  ...new Set(
    getBuiltinModels(plane as never).map((model: { id: string }) => model.id)
  ),
];

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

  it("measured with the probe innermost and both planes settled on the plugin's adapter", () => {
    expect(out.fatal).toBeUndefined();
    expect(out.fetchInnermost).toBe(true);
    expect(out.planesSettled).toBe(true);
  });

  it("the plane provider is built from the host's own pi, not the linked checkout's (both cells)", () => {
    // The plugin is installed as a `link:` to this checkout, whose own
    // development install holds a pi too; the plugin resolves the wrapper
    // from the loader's base URL, so it reaches the host prefix's copy — the
    // floating cell's floating pi included.
    expect(out.piLoaded).toEqual({
      fromHostPrefix: true,
      path: "node_modules/@earendil-works/pi-ai",
      version: hostPiVersion,
    });
  });

  it("[BASELINE] registry: both planes are the plugin's PlaneAdapter, no hidden route exists, and Settings addresses the planes under pi-ai's namespace with no error (D13)", () => {
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

  it("[BASELINE] listing before any turn: every declared id is listed (D21)", () => {
    expect(out.listModels).toEqual(S0_TODAY.listingBeforeTurn);
  });

  it("[BASELINE] listing after a turn on each plane: every declared id is still listed (G1)", () => {
    expect(out.listModelsAfter).toEqual(S0_TODAY.listingAfterTurn);
  });

  // A floating pi's own entry can move a model's metadata, so these are
  // pinned for the pi this repository pins; the floating cell's probe JSON is
  // the record.
  it.skipIf(!PINNED)(
    "resolveModelInfo, resolveCallConfig and the wire match the in-process rows (pinned pi)",
    () => {
      for (const [key, row] of Object.entries(S0_TODAY.rows)) {
        expect(out.modelInfo[key], key).toEqual(row.info);
        expect(out.callConfig[key], key).toBe(row.callConfig);
        expect(out.dispatch[key], key).toEqual({
          finish: row.finish,
          sent: row.sent,
        });
      }
      expect(
        out.dispatch["opencode-go/gemini-4-argon-contributor"]?.sent
      ).toEqual([
        "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse",
      ]);
      expect(out.callConfig["opencode-go/gemini-4-argon-contributor"]).toBe(
        "ok"
      );
    }
  );

  it("[BASELINE] the settings page reads every plane the profile declares", () => {
    expect(out.describe?.value.toSorted()).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
    ]);
  });

  it("[BASELINE] the Settings graft shows each plane's own entry, and the Models page reads both planes configured under their apiKeyEnv (D18)", () => {
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

  it("[BASELINE] a stored gap id blocks no save: the catalog-unknown id is accepted on the first try (D15)", () => {
    expect(out.saveBlocked).toEqual({ accepted: true, id: SAVE_CANDIDATE });
    expect(out.saveCleared).toBeUndefined();
  });

  it("[BASELINE] a catalog-unknown id saves to the file, is listed, validates and is sent as completions on the modern base (D15, D16)", () => {
    expect(out.save).toEqual({ accepted: true, id: SAVE_CANDIDATE });
    expect(out.savedInFile).toBe(true);
    expect(out.afterSave?.listed).toContain(SAVE_CANDIDATE);
    expect(out.afterSave?.callConfig).toBe("ok");
    expect(out.afterSave?.dispatch).toEqual({
      finish: "AUTH",
      sent: ["https://opencode.ai/inference/openai/v1/chat/completions"],
    });
  });

  it("[BASELINE] Settings' fetch on each plane offers the whole servable catalog, each id once, in the Remote's row shape (D3)", () => {
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
    expect(fetchedIds("opencode-go")).toContain("gemini-4-argon-contributor");
  });

  // A newer pi lists gap ids itself and orders its own list differently, so
  // only the pinned cell pins the order.
  it.skipIf(!PINNED)(
    "[BASELINE] Settings' fetch answers pi's own list first, then the catalog models pi lacks (pinned pi)",
    () => {
      for (const plane of PLANES) {
        const pi = piIds(plane);
        expect(fetchedIds(plane), plane).toEqual([
          ...pi,
          ...servable(plane).filter((id) => !pi.includes(id)),
        ]);
      }
    }
  );
});
