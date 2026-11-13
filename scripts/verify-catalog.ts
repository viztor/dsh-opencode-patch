/**
 * Verify the catalog, the declared list, and the routing table against each other.
 *
 * This exists because the failures it catches are all INVISIBLE from the outside: a
 * model that is dropped is not filtered, not deprecated and not erroring — it is
 * simply absent. Four separate bugs in this repository had that shape, and each one
 * was found by a hand-written script that was then thrown away. This is that script,
 * kept.
 *
 * Checks, in order:
 *
 * 1. **Shim freshness** — the bundled `catalog-data.ts` must match the live registry.
 * 2. **Dead rows** — no offered model may answer `400 Model is unavailable` or
 *    `410 ModelDeprecated` (needs `--probe`; otherwise skipped).
 * 3. **The declared list** — the composer's source (`planeProfileFor`) publishes
 *    exactly the ids a plane declares: Settings' fetch offers the catalog (D3),
 *    the composer never widens.
 * 4. **Routing** — every servable model must resolve, on its own plane's route,
 *    to a protocol and a base on that plane (`planeModelFor`, D13).
 * 5. **Free-tier tools** — every free model must get the core-tool fallback.
 *
 * Usage:
 *
 * ```sh
 * node --experimental-strip-types scripts/verify-catalog.ts
 * node --experimental-strip-types scripts/verify-catalog.ts --probe
 * ```
 *
 * Exit code is 1 when any check fails, so it can gate a release.
 *
 * @module scripts/verify-catalog
 */

import { OPENCODE_FAMILY_API } from "../src/catalog-data.ts";
import {
  getLiveGoCatalog,
  getLiveZenCatalog,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../src/models-catalog.ts";
import { openCodeSessionIdFor } from "../src/session.ts";
import { isCoreToolModel } from "../src/tool-fallback.ts";
import { planeModelFor } from "../src/utils/plane-model.ts";
import { planeProfileFor } from "../src/utils/plane-profile.ts";
import { isServableSdk, protocolForSdk } from "../src/utils/protocols.ts";

const PROBE = process.argv.includes("--probe");
const failures: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
};

const ok = (message: string): void => {
  console.log(`  ok    ${message}`);
};

// ── 1. Shim freshness ───────────────────────────────────────────────────────
console.log("\n1. shim freshness");
try {
  const response = await fetch(MODELS_OPENCODE_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  const live = parseModelsDevCatalog(await response.json());
  for (const [plane, shipped, fresh] of [
    ["zen", getLiveZenCatalog(), live.zen],
    ["go", getLiveGoCatalog(), live.go],
  ] as const) {
    const shippedIds = new Set(shipped.map((m) => m.id));
    // The shim and the live parse come from the same parser over the same
    // registry, so the comparison is raw against raw: a difference is
    // staleness, full stop. What the registry should have flagged but did
    // not is the probe's business, not this check's.
    const freshIds = new Set(fresh.map((m) => m.id));
    const missing = [...freshIds].filter((id) => !shippedIds.has(id));
    const extra = [...shippedIds].filter((id) => !freshIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      fail(
        `${plane} shim is stale: ${missing.length} missing, ${extra.length} extra ` +
          `(run scripts/regenerate-catalog-shim.ts --write)`
      );
    } else {
      ok(`${plane}: ${shippedIds.size} models match the registry`);
    }
  }
} catch (error) {
  console.log(`  skip  registry unreachable (${String(error).slice(0, 60)})`);
}

// ── 2. Dead rows ────────────────────────────────────────────────────────────
console.log(`\n2. dead rows ${PROBE ? "" : "(skipped: pass --probe)"}`);
// The probe reports the gateway's answer for each offered id; it cannot say
// WHY an id stopped answering, and the cause is not this repository's to
// fix — vendor retirement, upstream loss and account-scoped disablement all
// look identical from an unauthenticated POST. Current known report:
// `claude-sonnet-4` answers `400 "Model is unavailable."` while the registry
// does not flag it. Read the FAIL as "go look", never as a hint to add a
// local allowlist — a hand list is what this probe replaced.
if (PROBE) {
  // The gateway answers distinctly enough to classify every id with one token:
  // 401/403 means the model is there and only the credential is missing, 400
  // "Model is unavailable" and 410 ModelDeprecated mean it is gone.
  // **Probe each model on ITS OWN plane.** A Go-only model asked of the Zen
  // endpoint answers `400 Model is unavailable`, which reads as "gone" and is
  // not: it is on the other plane. The first version of this script did exactly
  // that and reported thirteen healthy Go models as dead.
  //
  // The Go plane also refuses a request carrying no session header ("Request is
  // missing x-opencode-session"), so one is minted for it.
  const session = openCodeSessionIdFor("verify-catalog");
  const classify = async (
    id: string,
    plane: "go" | "zen"
  ): Promise<"served" | "gone" | "unknown"> => {
    try {
      const endpoint =
        plane === "go"
          ? "https://opencode.ai/zen/go/v1/chat/completions"
          : "https://opencode.ai/zen/v1/chat/completions";
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: "hi", role: "user" }],
          model: id,
        }),
        headers: {
          "content-type": "application/json",
          ...(plane === "go"
            ? {
                "X-Session-Id": session,
                "x-opencode-session": session,
                "x-opencode-session-id": session,
                "x-session-affinity": session,
              }
            : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 401 || response.status === 403) {
        return "served";
      }
      if (response.status === 400 || response.status === 410) {
        return "gone";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  };
  const dead: string[] = [];
  for (const [plane, catalog] of [
    ["zen", getLiveZenCatalog()],
    ["go", getLiveGoCatalog()],
  ] as const) {
    for (const model of catalog) {
      if ((await classify(model.id, plane)) === "gone") {
        dead.push(`${plane}/${model.id}`);
      }
    }
  }
  if (dead.length > 0) {
    fail(`offered but gone: ${dead.join(", ")}`);
  } else {
    ok("every offered model answers");
  }
}

// ── 3. The declared list is published verbatim ──────────────────────────────
console.log("\n3. the declared list is not widened");
for (const [route, catalog, plane] of [
  ["opencode", getLiveZenCatalog(), "zen"],
  ["opencode-go", getLiveGoCatalog(), "go"],
] as const) {
  // A deployment declares some ids; the composer must publish exactly those.
  // An earlier revision merged the whole catalog in, which silently overrode
  // every `models:` array. This asserts the opposite: declared in, declared
  // out. The composer's list is the plane profile's provider, built here with
  // a stub that hands back the models it is given; Settings' fetch is a
  // different surface, and offers the catalog on purpose (D3).
  const declared = catalog
    .filter((m) => isServableSdk(m.provider_npm))
    .slice(0, 3)
    .map((m) => ({ id: m.id, name: m.name }));
  const { profile } = planeProfileFor({
    buildProvider: ({ models }) => ({ getModels: () => models }),
    catalog,
    endpoint: "auto",
    entry: { models: declared },
    familyApi: OPENCODE_FAMILY_API[plane],
    piModels: [],
    resolveRetryPolicy: () => ({}),
    route,
  });
  const provider = profile.piProvider as
    | { getModels?: () => readonly { id?: unknown }[] }
    | undefined;
  if (typeof provider?.getModels !== "function") {
    fail(
      `${route}: the plane profile did not build: ${profile.catalogError ?? "no provider"}`
    );
    continue;
  }
  const listedIds = new Set(provider.getModels().map((m) => String(m.id)));
  const declaredIds = declared.map((m) => m.id);
  const added = [...listedIds].filter((id) => !declaredIds.includes(id));
  // Declared OUT too: an empty provider would otherwise pass as "nothing added".
  const missing = declaredIds.filter((id) => !listedIds.has(id));
  if (added.length > 0) {
    fail(
      `${route}: ${added.length} undeclared models were added: ${added.slice(0, 5).join(", ")}`
    );
  } else if (missing.length > 0) {
    fail(`${route}: declared models were not published: ${missing.join(", ")}`);
  } else {
    ok(
      `${route}: exactly the ${declaredIds.length} declared model(s), nothing added`
    );
  }
}

// ── 4. Routing ──────────────────────────────────────────────────────────────
console.log("\n4. routing");
{
  // One route per plane serves every protocol (D13), so a model is routable
  // when the plane adapter builds it on the protocol its SDK names and on a
  // base of its own plane.
  const unroutable: string[] = [];
  let served = 0;
  for (const [route, catalog, family] of [
    ["opencode", getLiveZenCatalog(), OPENCODE_FAMILY_API.zen],
    ["opencode-go", getLiveGoCatalog(), OPENCODE_FAMILY_API.go],
  ] as const) {
    for (const spec of catalog) {
      const { model, error } = planeModelFor({
        defaults: {
          contextWindow: 262_144,
          input: ["text"],
          maxTokens: 32_768,
        },
        endpoint: "modern",
        entry: { id: spec.id },
        familyApi: family,
        route,
        spec,
      });
      const onGo =
        model !== undefined &&
        new URL(model.baseUrl).pathname.startsWith("/inference/go/");
      if (
        model === undefined ||
        model.api !== protocolForSdk(spec.provider_npm) ||
        onGo !== (route === "opencode-go")
      ) {
        unroutable.push(
          `${route}/${spec.id} -> ${model === undefined ? error : `${model.api} ${model.baseUrl}`}`
        );
        continue;
      }
      served += 1;
    }
  }
  if (unroutable.length > 0) {
    fail(`unroutable: ${unroutable.join(", ")}`);
  } else {
    ok(`every catalog model (${served}) resolves on its own plane's route`);
  }
}

// ── 5. Free-tier tools ──────────────────────────────────────────────────────
console.log("\n5. free-tier core tools");
{
  const uncovered: string[] = [];
  for (const model of [...getLiveZenCatalog(), ...getLiveGoCatalog()]) {
    if (model.is_free === true && !isCoreToolModel(model.id, "free")) {
      uncovered.push(model.id);
    }
  }
  if (uncovered.length > 0) {
    fail(`free models with no tool fallback: ${uncovered.join(", ")}`);
  } else {
    ok("every free model gets the core-tool fallback");
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("");
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s)`);
  process.exitCode = 1;
} else {
  console.log(
    "PASS: catalog, declared list, routing and free-tier tools agree"
  );
}
