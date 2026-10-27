/**
 * The keyed probes' tier, cells and classifier, offline.
 *
 * The live half (`test/e2e/keyed-probes.e2e.ts`) sends one request per plane ×
 * protocol × URL shape with the plane's own key, which only CI can do; every
 * decision it makes is made here — which tier arms what, which headers carry
 * the key and the plugin's identity, how small each body is, how an answer
 * (and a retried one) is read, what a plane's verdicts decide, that a key
 * never reaches a printed excerpt, which pull requests CI arms it on, how the
 * record is kept, and — read from the live files — that every live suite
 * reads its key at its own tier and no probe follows a redirect. The
 * keyed cells also go through the offline gateway mock's own judge
 * (`handleGatewayRequest`), which refuses a request with no session header as
 * the live Go plane does.
 *
 * @module test/keyed-probes.test
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { handleGatewayRequest } from "./mock/opencode-gateway.ts";
import {
  armedKey,
  breaksDefault,
  classifyKeyedProbe,
  credentialHeaders,
  excerpt,
  FLIP_EVIDENCE,
  isArmed,
  keyedBody,
  keyedCell,
  keyedTierOf,
  keyedVerdictOf,
  planeOutcome,
  pluginIdentityHeaders,
  PROBE_IDENTITY,
  PROBE_SESSION_ID,
} from "./support/keyed-probes.ts";
import {
  cellKey,
  keylessMatrix,
  type MatrixCell,
  type MatrixPlane,
  TODAY_DISPATCH,
} from "./support/keyless-matrix.ts";
import {
  type ActiveTurnState,
  authHeaderFor,
  type CatalogModelSpec,
  clearCapturedApiKeys,
  CONFIG_DEFAULTS,
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  newOpenCodeMessageId,
  OPENCODE_GO_CATALOG,
  OPENCODE_PATCH_USER_AGENT,
  OPENCODE_UA,
  OPENCODE_ZEN_CATALOG,
  patchFetch,
  resolveConfig,
  SESSION_HEADER,
} from "./support/src.ts";
import { blankCommentLines } from "./support/strip-comments.ts";

const spec = (id: string, provider_npm?: string): CatalogModelSpec => ({
  context_window: 1000,
  id,
  input_modalities: ["text"],
  max_output_tokens: 100,
  name: id,
  ...(provider_npm === undefined ? {} : { provider_npm }),
});

/** The credential headers, lower-cased: a keyless cell carries none of them. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

/** A live suite's source with its comment lines blanked, as the gates read it. */
const liveSource = (name: string): string =>
  blankCommentLines(
    readFileSync(new URL(`e2e/${name}`, import.meta.url), "utf8")
  );

/** One paid model per protocol on each plane. */
const ZEN = [
  spec("zen-chat"),
  spec("zen-resp", "@ai-sdk/openai"),
  spec("zen-claude", "@ai-sdk/anthropic"),
  spec("zen-gemini", "@ai-sdk/google"),
];
const GO = [
  spec("go-chat"),
  spec("go-resp", "@ai-sdk/openai"),
  spec("go-claude", "@ai-sdk/anthropic"),
  spec("go-gemini", "@ai-sdk/google"),
];

// The fetch-patch case below captures the key it sends, process-wide.
afterEach(() => {
  clearCapturedApiKeys();
});

describe("keyed probes · the tier", () => {
  it.each([
    [undefined, "full"],
    ["", "full"],
    ["  ", "full"],
    ["none", "none"],
    ["probes", "probes"],
    [" probes ", "probes"],
    ["full", "full"],
  ] as const)("OPENCODE_E2E_KEYED=%j → %s", (value, tier) => {
    expect(keyedTierOf(value)).toBe(tier);
  });

  it("the tier: unset is full, a known value is itself, anything else fails the run; arming", () => {
    expect(() => keyedTierOf("prob")).toThrow(
      'OPENCODE_E2E_KEYED must be one of none, probes, full; got "prob"'
    );
    expect(isArmed("none", "probes")).toBe(false);
    expect(isArmed("none", "full")).toBe(false);
    expect(isArmed("probes", "probes")).toBe(true);
    expect(isArmed("probes", "full")).toBe(false);
    expect(isArmed("full", "probes")).toBe(true);
    expect(isArmed("full", "full")).toBe(true);

    expect(armedKey("full", "full", "k")).toBe("k");
    expect(armedKey("probes", "probes", "k")).toBe("k");
    expect(armedKey("probes", "full", "k")).toBeUndefined();
    expect(armedKey("full", "full", "")).toBeUndefined();
    expect(armedKey("full", "full")).toBeUndefined();
    expect(armedKey("none", "probes", "k")).toBeUndefined();
  });
});

describe("keyed probes · the cells", () => {
  it("a keyed cell is the keyless cell with the plugin's identity, the plane's key in the header its protocol reads, and a tiny body each endpoint accepts with a key", () => {
    const cells = keylessMatrix({ go: GO, zen: ZEN });
    expect(cells).toHaveLength(24);
    for (const cell of cells) {
      expect(cell.model, cell.url).toBeDefined();
      const keyed = keyedCell(cell, "test-key");
      expect(keyed.url).toBe(cell.url);
      expect(keyed.model).toBe(cell.model);
      expect(keyed.family).toBe(cell.family);
      expect(keyed.plane).toBe(cell.plane);
      expect(keyed.protocol).toBe(cell.protocol);
      expect(keyed.method).toBe(cell.method);
      // The probe and the plugin's fetch patch agree on every URL, the root
      // and legacy shapes included.
      expect(
        Object.keys(credentialHeaders(cell.protocol, "test-key")),
        cell.url
      ).toEqual([authHeaderFor(cell.url)]);
      expect(keyed.headers["content-type"]).toBe("application/json");
      // The plugin's identity, on every cell: a turn's user agent (not the
      // one the plugin signs its own requests with), the origin client, the
      // project, and one in-band session id under both headers.
      expect(keyed.headers["user-agent"]).toBe(OPENCODE_UA);
      expect(keyed.headers["user-agent"]).not.toBe(OPENCODE_PATCH_USER_AGENT);
      expect(keyed.headers["x-opencode-client"]).toBe(
        CONFIG_DEFAULTS.originClient
      );
      expect(keyed.headers["x-opencode-project"]).toBe("global");
      expect(keyed.headers[SESSION_HEADER]).toBe(PROBE_SESSION_ID);
      expect(keyed.headers["x-opencode-session-id"]).toBe(PROBE_SESSION_ID);
      if (
        cell.protocol === "openai-completions" ||
        cell.protocol === "openai-responses"
      ) {
        expect(keyed.headers.authorization).toBe("Bearer test-key");
      } else if (cell.protocol === "anthropic-messages") {
        expect(keyed.headers["x-api-key"]).toBe("test-key");
        expect(keyed.headers["anthropic-version"]).toBe("2023-06-01");
      } else {
        expect(keyed.headers["x-goog-api-key"]).toBe("test-key");
      }
      expect(keyed.body).toEqual(keyedBody(cell.protocol, cell.model ?? ""));
    }
    // The keyless cells themselves are untouched: no credential header on any.
    for (const cell of cells) {
      expect(
        Object.keys(cell.headers).filter((header) =>
          CREDENTIAL_HEADERS.has(header.toLowerCase())
        ),
        cell.url
      ).toEqual([]);
    }

    expect(keyedBody("openai-completions", "m")).toEqual({
      max_tokens: 8,
      messages: [{ content: "hi", role: "user" }],
      model: "m",
      stream: false,
    });
    expect(keyedBody("openai-responses", "m")).toEqual({
      input: "hi",
      max_output_tokens: 16,
      model: "m",
    });
    expect(keyedBody("anthropic-messages", "m")).toEqual({
      max_tokens: 1,
      messages: [{ content: "hi", role: "user" }],
      model: "m",
    });
    expect(keyedBody("google-generative-ai", "m")).toEqual({
      contents: [{ parts: [{ text: "hi" }], role: "user" }],
      generationConfig: { maxOutputTokens: 8 },
    });

    const modelless = keylessMatrix({ go: [], zen: ZEN }).find(
      (cell) => cell.model === undefined
    );
    expect(modelless).toBeDefined();
    if (modelless !== undefined) {
      expect(keyedCell(modelless, "test-key").body).toBeUndefined();
    }
  });

  it.for(["opencode", "opencode-go"] as const)(
    "%s: every identity header on a keyed cell is what the real fetch patch puts on a turn, but the per-request message id it leaves out on purpose",
    async (plane) => {
      // Derived, not restated: one turn through the real `patchFetch`, with
      // the defaults, the probe's session id and a message id as a real
      // turn's state carries (`stream-hook.ts`), over a recording fetch. A
      // change to the patch's identity — its user agent, a header added or
      // renamed — or to `PROBE_IDENTITY`, the constant the live suite sends,
      // fails here rather than leaving the live probe behind.
      const cell = keylessMatrix({ go: GO, zen: ZEN }).find(
        (candidate) =>
          candidate.plane === plane &&
          candidate.family === "modern" &&
          candidate.protocol === "openai-completions"
      );
      expect(cell).toBeDefined();
      if (cell === undefined) {
        return;
      }
      let wire = new Headers();
      const recording = (
        _input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        wire = new Headers(init?.headers);
        return Promise.resolve(new Response("{}"));
      };
      const als = new AsyncLocalStorage<ActiveTurnState>();
      const patched = patchFetch(
        recording as typeof fetch,
        als,
        resolveConfig()
      );
      const requestValue = newOpenCodeMessageId();
      await als.run(
        { provider: plane, requestValue, value: PROBE_SESSION_ID },
        () =>
          patched(cell.url, {
            body: JSON.stringify(keyedBody(cell.protocol, cell.model ?? "m")),
            headers: {
              authorization: "Bearer sk-probe-0123456789abcdef",
              "content-type": "application/json",
            },
            method: "POST",
          })
      );
      // The one exclusion, by name: the turn's message id, which the gateway
      // reads only as a metric and which is fresh per request, so the probe
      // identity carries none (`pluginIdentityHeaders`).
      const METRIC_ONLY = "x-opencode-request";
      expect(wire.get(METRIC_ONLY)).toBe(requestValue);
      expect(isOpenCodeMessageId(requestValue)).toBe(true);
      expect(PROBE_IDENTITY).not.toHaveProperty(METRIC_ONLY);
      const identityOnWire = [...wire.keys()].filter(
        (name) =>
          name !== METRIC_ONLY &&
          (name === "user-agent" || name.startsWith("x-opencode-"))
      );
      expect(identityOnWire.toSorted()).toEqual(
        Object.keys(PROBE_IDENTITY).toSorted()
      );
      const keyed = keyedCell(cell, "sk-probe-0123456789abcdef");
      for (const name of identityOnWire) {
        expect(keyed.headers[name], name).toBe(wire.get(name));
      }
      expect(wire.get("user-agent")).toBe(OPENCODE_UA);
    }
  );

  it("the live suite sends PROBE_IDENTITY and has no identity of its own", () => {
    // The live file is not loaded offline, so its wiring is read: every
    // keyed cell it builds takes keyedCell's default identity, the constant
    // the case above holds to the real fetch patch.
    const live = blankCommentLines(
      readFileSync(new URL("e2e/keyed-probes.e2e.ts", import.meta.url), "utf8")
    );
    const calls = [...live.matchAll(/keyedCell\(([^)]*)\)/gu)].map(
      (match) => match[1] ?? ""
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.split(",").map((arg) => arg.trim())).toHaveLength(2);
    }
    for (const name of [
      "pluginIdentityHeaders",
      "OPENCODE_UA",
      "OPENCODE_PATCH_USER_AGENT",
      '"user-agent"',
    ]) {
      expect(live, name).not.toContain(name);
    }
    expect(pluginIdentityHeaders(OPENCODE_UA)).toEqual(PROBE_IDENTITY);
  });

  it("every live suite reads a key only through armedKey at its own tier: the keyed probes at `probes`, the full keyed suites at `full`, the keyless matrix never", () => {
    // The live files are not loaded offline, and ci.yml passes both secrets
    // on a `probes` pull request, so a full suite that read a key straight
    // from the environment would spend it on every such pull request, and
    // keyed probes armed at `full` would never probe one: both stay green
    // everywhere else.
    const NEED: Readonly<Record<string, "full" | "probes">> = {
      "dispatch-levels.e2e.ts": "full",
      "keyed-probes.e2e.ts": "probes",
      "opencode-live.e2e.ts": "full",
      "protocol-routing.e2e.ts": "full",
    };
    const files = readdirSync(new URL("e2e/", import.meta.url)).filter((name) =>
      name.endsWith(".e2e.ts")
    );
    // The input was read: the four keyed suites and the keyless matrix are
    // among the files walked.
    for (const name of [...Object.keys(NEED), "keyless-matrix.e2e.ts"]) {
      expect(files, name).toContain(name);
    }
    const READ = /process\.env(?:\.|\[\s*["'`])OPENCODE_(?:GO_)?API_KEY\b/gu;
    const ARMED =
      /armedKey\(\s*TIER,\s*"(full|probes)",\s*process\.env\.OPENCODE_(?:GO_)?API_KEY\s*\)/gu;
    for (const name of files) {
      const live = liveSource(name);
      const reads = [...live.matchAll(READ)].length;
      const armed = [...live.matchAll(ARMED)].map((match) => match[1]);
      const need = NEED[name];
      expect(live, `${name} destructures a key out of process.env`).not.toMatch(
        /\}\s*=\s*process\.env\b/u
      );
      if (need === undefined) {
        expect(reads, `${name} reads a key`).toBe(0);
        continue;
      }
      // Both planes' keys, each through armedKey at the suite's tier, and no
      // other read of either.
      expect(reads, name).toBe(2);
      expect(armed, name).toEqual([need, need]);
      expect(live, name).toContain(
        "const TIER = keyedTierOf(process.env.OPENCODE_E2E_KEYED);"
      );
    }
    expect(liveSource("keyless-matrix.e2e.ts")).not.toContain(
      "OPENCODE_E2E_KEYED"
    );
  });

  it('no probe follows a redirect: every request the two probe suites send is `redirect: "manual"`, but the catalog GET, which carries no key', () => {
    // A followed redirect never shows its 3xx, so `redirected` could not
    // occur live, a moved path would be judged by its target's answer, and a
    // cross-origin hop would carry `x-api-key` / `x-goog-api-key` with it.
    for (const name of ["keyless-matrix.e2e.ts", "keyed-probes.e2e.ts"]) {
      const calls = [
        ...liveSource(name).matchAll(/\bfetch\(\s*([^,]+),\s*\{([^}]*)\}/gu),
      ].map((match) => ({ options: match[2] ?? "", target: match[1] ?? "" }));
      const probes = calls.filter(
        (call) => call.target.trim() !== "MODELS_OPENCODE_URL"
      );
      // The input was read: one catalog GET and at least one probe each.
      expect(calls.length - probes.length, name).toBe(1);
      expect(probes.length, name).toBeGreaterThan(0);
      for (const call of probes) {
        expect(call.options, `${name}: fetch(${call.target})`).toMatch(
          /\bredirect:\s*"manual"/u
        );
      }
      // And no fetch call escaped the pattern above (one without an inline
      // options object).
      expect([...liveSource(name).matchAll(/\bfetch\(/gu)].length, name).toBe(
        calls.length
      );
    }
  });

  it("the probe's session id is the client's shape, inside the band the gateway admits", () => {
    expect(isOpenCodeSessionId(PROBE_SESSION_ID)).toBe(true);
    const low12 = Number.parseInt(PROBE_SESSION_ID.slice(4, 16), 16) % 0x1000;
    expect(low12).toBeGreaterThanOrEqual(0xfc0);
    expect(low12).toBeLessThanOrEqual(0xffe);
  });

  it("an excerpt never carries the key, and is at most 200 characters", () => {
    expect(excerpt('{"error":"bad key test-key test-key"}', "test-key")).toBe(
      '{"error":"bad key <redacted> <redacted>"}'
    );
    expect(excerpt("x".repeat(500), "k")).toHaveLength(200);
    // An empty key redacts nothing, rather than interleaving the marker.
    expect(excerpt("abc", "")).toBe("abc");
  });
});

describe("keyed probes · through the offline gateway's own judge", () => {
  /** What the mock gateway answers one keyed cell, read as the live suite reads it. */
  const judged = (
    cell: MatrixCell,
    identity: Readonly<Record<string, string>>
  ): { cell: string; verdict: string } => {
    const keyed = keyedCell(cell, "sk-probe-0123456789abcdef", identity);
    const url = new URL(keyed.url);
    const { reply } = handleGatewayRequest({
      bodyText: JSON.stringify(keyed.body),
      headers: keyed.headers,
      method: keyed.method,
      url: `${url.pathname}${url.search}`,
    });
    return {
      cell: cellKey(cell),
      verdict: keyedVerdictOf([{ bodyText: reply.body, status: reply.status }]),
    };
  };

  const cells = keylessMatrix({
    go: OPENCODE_GO_CATALOG,
    zen: OPENCODE_ZEN_CATALOG,
  });
  const planeRows = (
    plane: MatrixPlane,
    identity: Readonly<Record<string, string>>
  ) =>
    cells
      .filter((cell) => cell.plane === plane)
      .map((cell) => judged(cell, identity));

  it.for(["opencode", "opencode-go"] as const)(
    "%s: with the plugin's identity every default cell is served and the plane passes; without it the session is refused and the plane fails",
    (plane) => {
      const rows = planeRows(plane, PROBE_IDENTITY);
      for (const row of rows) {
        if (TODAY_DISPATCH.has(row.cell)) {
          expect(row.verdict, row.cell).toBe("served");
        }
      }
      expect(planeOutcome(rows)).toEqual({ kind: "pass" });

      // The defect a session-less probe had: every routed cell refused, read
      // as a failure that is not flip evidence — never as a pass.
      const bare = planeRows(plane, {});
      expect(
        bare
          .filter((row) => TODAY_DISPATCH.has(row.cell))
          .map((row) => row.verdict)
      ).toEqual(Array.from({ length: 4 }, () => "session-refused"));
      const outcome = planeOutcome(bare);
      expect(outcome.kind).toBe("fail");
      expect(outcome.kind === "fail" ? outcome.reason : "").toContain(
        "not flip evidence"
      );
    }
  );
});

describe("keyed probes · reading an answer", () => {
  it.each([
    [200, "{}", "served"],
    [204, "", "served"],
    [404, "", "path-gone"],
    [404, '{"error":{"message":"no route","type":"not_found"}}', "path-gone"],
    [
      404,
      '{"type":"error","error":{"type":"not_found_error","message":"model: x"}}',
      "model-gone",
    ],
    // Anthropic's generic 404 — an unknown route included — names no model.
    [
      404,
      '{"type":"error","error":{"type":"not_found_error","message":"Not Found"}}',
      "path-gone",
    ],
    [404, '{"error":{"code":"model_not_found"}}', "model-gone"],
    [
      404,
      '{"error":{"message":"models/gemini-x is not found for API version v1beta"}}',
      "model-gone",
    ],
    [410, "", "model-gone"],
    [400, '{"error":{"message":"Model is unavailable"}}', "model-gone"],
    [400, '{"error":{"type":"ModelProtocolUnsupported"}}', "wrong-protocol"],
    [400, '{"error":{"message":"max_output_tokens too small"}}', "path-exists"],
    [
      400,
      '{"error":{"message":"MissingSessionID","type":"missing_session_id"}}',
      "session-refused",
    ],
    [400, "missing x-opencode-session header", "session-refused"],
    [403, '{"error":{"type":"FreeTierError"}}', "session-refused"],
    [401, '{"error":{"type":"AuthError"}}', "auth-refused"],
    [403, "", "auth-refused"],
    [403, '{"error":{"message":"Model access is disabled"}}', "account"],
    [401, "Insufficient account funds", "account"],
    [402, "", "account"],
    [429, "", "rate-limited"],
    [500, "", "other"],
    [502, "", "other"],
    [500, '{"error":{"message":"internal error"}}', "other"],
    // The upstream busy: the gateway may have routed it, or answered first.
    [503, "", "upstream-busy"],
    [
      529,
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "upstream-busy",
    ],
    [
      503,
      '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
      "upstream-busy",
    ],
    [
      500,
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "upstream-busy",
    ],
    // Each busy condition alone decides its row: a bare 529, and a Gemini
    // overload the gateway re-wraps as a 500 or a 502, by either of its two
    // markers.
    [529, "", "upstream-busy"],
    [502, '{"error":{"status":"UNAVAILABLE"}}', "upstream-busy"],
    [500, '{"error":{"message":"The model is overloaded."}}', "upstream-busy"],
    // The marker is case-sensitive, and a plain 5xx is not busy: a proxy's
    // "Service Unavailable" page and a gateway timeout stay `other`.
    [502, "<html>Service Unavailable</html>", "other"],
    [504, "", "other"],
    [301, "", "redirected"],
    [302, "", "redirected"],
    [308, "", "redirected"],
  ] as const)("%i %s → %s", (status, bodyText, verdict) => {
    expect(classifyKeyedProbe({ bodyText, status })).toBe(verdict);
  });

  const answer = (status: number, bodyText = "") => ({ bodyText, status });

  it.each([
    ["one 200", [answer(200)], "served"],
    ["one 404", [answer(404)], "path-gone"],
    [
      "429, then no answer (the measured rate-limit hang)",
      [answer(429), undefined],
      "rate-limited",
    ],
    ["429, then 429", [answer(429), answer(429)], "rate-limited"],
    ["429, then 200", [answer(429), answer(200)], "served"],
    ["no answer, twice", [undefined, undefined], "transport-error"],
    ["500, then no answer", [answer(500), undefined], "transport-error"],
    // Only a 429 makes no answer a rate limit: a busy upstream and then no
    // answer measured nothing, as a 500 and then no answer did not.
    ["529, then no answer", [answer(529), undefined], "transport-error"],
    ["503, then no answer", [answer(503), undefined], "transport-error"],
    ["500, then 500", [answer(500), answer(500)], "other"],
    ["529, then 503", [answer(529), answer(503)], "upstream-busy"],
    ["529, then 200", [answer(529), answer(200)], "served"],
    ["no answer, then 401", [undefined, answer(401)], "auth-refused"],
  ] as const)("attempts: %s → %s", (_name, attempts, verdict) => {
    expect(keyedVerdictOf(attempts)).toBe(verdict);
  });

  it("which verdicts fail the job, and which of them are flip evidence", () => {
    expect([...FLIP_EVIDENCE].toSorted()).toEqual([
      "auth-refused",
      "path-gone",
      "wrong-protocol",
    ]);
    for (const verdict of [
      "path-gone",
      "wrong-protocol",
      "auth-refused",
      "other",
      "redirected",
      "session-refused",
      "transport-error",
      "no-model",
    ]) {
      expect(breaksDefault(verdict), verdict).toBe(true);
    }
    for (const verdict of [
      "served",
      "path-exists",
      "model-gone",
      "account",
      "rate-limited",
      "upstream-busy",
    ]) {
      expect(breaksDefault(verdict), verdict).toBe(false);
    }
  });
});

describe("keyed probes · what a plane decides", () => {
  /** A plane's twelve rows (Zen unless named): each default cell's verdict, every legacy and root cell `rest`. */
  const plane = (
    defaults: readonly string[],
    rest = "path-gone",
    name: "opencode" | "opencode-go" = "opencode"
  ): { cell: string; verdict: string }[] => {
    const modern = [...TODAY_DISPATCH].filter((cell) =>
      cell.startsWith(`${name} `)
    );
    return [
      ...modern.map((cell, index) => ({
        cell,
        verdict: defaults[index] ?? "served",
      })),
      ...modern.flatMap((cell) =>
        ["legacy", "root"].map((family) => ({
          cell: cell.replace(/ modern$/u, ` ${family}`),
          verdict: rest,
        }))
      ),
    ];
  };

  it.each([
    [
      "default cells all account, a root path-gone",
      plane(["account", "account", "account", "account"]),
      "skip",
    ],
    [
      "default cells all model-gone",
      plane(["model-gone", "model-gone", "model-gone", "model-gone"]),
      "skip",
    ],
    [
      "default cells all path-exists (a parsed but refused body)",
      plane(["path-exists", "path-exists", "path-exists", "path-exists"]),
      "skip",
    ],
    [
      "default cells all rate-limited",
      plane(["rate-limited", "rate-limited", "rate-limited", "rate-limited"]),
      "skip",
    ],
    [
      "default cells all upstream-busy",
      plane([
        "upstream-busy",
        "upstream-busy",
        "upstream-busy",
        "upstream-busy",
      ]),
      "skip",
    ],
    [
      "one default upstream-busy, the rest served",
      plane(["served", "upstream-busy", "served", "served"]),
      "pass",
    ],
    [
      "one default path-gone, the rest account",
      plane(["path-gone", "account", "account", "account"]),
      "fail",
    ],
    [
      "one default transport-error, the rest served",
      plane(["served", "served", "served", "transport-error"]),
      "fail",
    ],
    [
      "one default served, the rest account; every other shape broken",
      plane(["served", "account", "account", "account"], "other"),
      "pass",
    ],
    [
      "every default served",
      plane(["served", "served", "served", "served"]),
      "pass",
    ],
    [
      "no default cell at all",
      [{ cell: "opencode openai-completions legacy", verdict: "served" }],
      "fail",
    ],
  ] as const)("%s → %s", (_name, rows, kind) => {
    expect(planeOutcome(rows).kind).toBe(kind);
  });

  /** `rows` with each named cell's verdict replaced. */
  const withCells = (
    rows: readonly { cell: string; verdict: string }[],
    verdicts: Readonly<Record<string, string>>
  ): { cell: string; verdict: string }[] =>
    rows.map((row) => ({ ...row, verdict: verdicts[row.cell] ?? row.verdict }));
  const ZEN_CHAT = "opencode openai-completions";

  it.each([
    // A default cell's model-gone is read beside the same model on the
    // other shapes: the gateway answers "Model is unavailable" for an id
    // sent where it is not served too, so a model another shape accepts is
    // the default family refusing it.
    [
      "modern model-gone, the same model served on legacy",
      { [`${ZEN_CHAT} legacy`]: "served" },
      "fail",
      "(flip evidence",
    ],
    [
      // Nothing dispatches to the root, so no flip of the default reaches
      // the shape that took the model: the plane fails, but not as evidence.
      "modern model-gone, the same model a parsed body on root only",
      { [`${ZEN_CHAT} root`]: "path-exists" },
      "fail",
      "(not flip evidence: no flip reaches that shape)",
    ],
    [
      // The account's gate answers before the model is routed, so it says
      // nothing about whether legacy serves the model.
      "modern model-gone, the account's answer on legacy",
      { [`${ZEN_CHAT} legacy`]: "account" },
      "pass",
      undefined,
    ],
    [
      "modern model-gone, the same model gone on every shape",
      {
        [`${ZEN_CHAT} legacy`]: "model-gone",
        [`${ZEN_CHAT} root`]: "model-gone",
      },
      "pass",
      undefined,
    ],
    ["modern model-gone, the other shapes' paths gone", {}, "pass", undefined],
  ] as const)(
    "a retired model, read across the shapes: %s → %s",
    (_name, siblings, kind, reason) => {
      const outcome = planeOutcome(
        withCells(plane(["model-gone", "served", "served", "served"]), siblings)
      );
      expect(outcome.kind).toBe(kind);
      if (outcome.kind === "fail") {
        expect(outcome.reason).toContain(reason);
        if (reason?.startsWith("(not") === true) {
          expect(outcome.reason).not.toContain("(flip evidence");
        }
        expect(outcome.broken).toEqual([
          { cell: `${ZEN_CHAT} modern`, verdict: "model-gone" },
        ]);
      }
    }
  );

  it.each([
    [
      "auth-refused, the key refused on every shape (a revoked CI secret)",
      "auth-refused",
      "auth-refused",
      "not flip evidence: check the CI secret",
    ],
    [
      // A gone path never measured the key: the gateway answers 404 before
      // it authenticates.
      "auth-refused, the other shapes' paths gone",
      "auth-refused",
      "path-gone",
      "not flip evidence: nothing else measured the key",
    ],
    [
      "auth-refused, the other shapes rate-limited",
      "auth-refused",
      "rate-limited",
      "not flip evidence: nothing else measured the key",
    ],
    [
      // A busy answer may come from the gateway's front, before the key is
      // read, so it is not the key accepted.
      "auth-refused, the other shapes' upstream busy",
      "auth-refused",
      "upstream-busy",
      "not flip evidence: nothing else measured the key",
    ],
    [
      "auth-refused, the same key served on legacy",
      "auth-refused",
      "served",
      "(flip evidence",
    ],
    [
      "path-gone on every shape",
      "path-gone",
      "path-gone",
      "not flip evidence: a flip would not serve it",
    ],
    [
      "path-gone, the path existing on legacy",
      "path-gone",
      "path-exists",
      "(flip evidence",
    ],
    [
      // The model's protocol refused everywhere is the model, not the family.
      "wrong-protocol on every shape",
      "wrong-protocol",
      "wrong-protocol",
      "not flip evidence: a flip would not serve it",
    ],
    [
      "wrong-protocol, the same request served on legacy",
      "wrong-protocol",
      "served",
      "(flip evidence",
    ],
  ] as const)(
    "a refused protocol, key or path is flip evidence only beside the shape a flip reaches, having accepted it: %s",
    (_name, verdict, rest, reason) => {
      // Every cell of the plane answers `rest` but the first default cell.
      const outcome = planeOutcome(plane([verdict, rest, rest, rest], rest));
      expect(outcome.kind).toBe("fail");
      expect(outcome.kind === "fail" ? outcome.reason : "").toContain(reason);
      if (reason.startsWith("not")) {
        expect(outcome.kind === "fail" ? outcome.reason : "").not.toContain(
          "(flip evidence"
        );
      }
    }
  );

  /** The fail reason of `rows`' outcome, or `""` when it did not fail. */
  const failReason = (rows: readonly { cell: string; verdict: string }[]) => {
    const outcome = planeOutcome(rows);
    expect(outcome.kind).toBe("fail");
    return outcome.kind === "fail" ? outcome.reason : "";
  };
  const GO_GOOGLE = "opencode-go google-generative-ai";
  const GO_CHAT = "opencode-go openai-completions";

  it.each([
    [
      // A flip of the default sends Zen's completions to legacy, which is
      // gone too: only the root, which nothing reaches, accepted it.
      "Zen completions: modern and legacy path-gone, root served",
      withCells(plane(["path-gone", "served", "served", "served"]), {
        [`${ZEN_CHAT} root`]: "served",
      }),
      false,
    ],
    [
      "Zen completions: modern path-gone, legacy served",
      withCells(plane(["path-gone", "served", "served", "served"]), {
        [`${ZEN_CHAT} legacy`]: "served",
      }),
      true,
    ],
    [
      // Go's Google stays on its modern cell under every family, so its
      // `/zen/go` sibling is a shape no setting sends to.
      "Go Google: modern path-gone, its /zen/go sibling path-exists",
      withCells(
        plane(
          ["served", "served", "served", "path-gone"],
          "path-gone",
          "opencode-go"
        ),
        { [`${GO_GOOGLE} legacy`]: "path-exists" }
      ),
      false,
    ],
    [
      "Go Google: modern model-gone, the same model a parsed body on root",
      withCells(
        plane(
          ["served", "served", "served", "model-gone"],
          "path-gone",
          "opencode-go"
        ),
        { [`${GO_GOOGLE} root`]: "path-exists" }
      ),
      false,
    ],
    [
      "Go Google: modern auth-refused, its /zen/go sibling served",
      withCells(
        plane(
          ["served", "served", "served", "auth-refused"],
          "path-gone",
          "opencode-go"
        ),
        { [`${GO_GOOGLE} legacy`]: "served" }
      ),
      false,
    ],
    [
      "Go completions: modern path-gone, legacy served",
      withCells(
        plane(
          ["path-gone", "served", "served", "served"],
          "path-gone",
          "opencode-go"
        ),
        { [`${GO_CHAT} legacy`]: "served" }
      ),
      true,
    ],
    [
      "Go completions: modern wrong-protocol, root served only",
      withCells(
        plane(
          ["wrong-protocol", "served", "served", "served"],
          "path-gone",
          "opencode-go"
        ),
        { [`${GO_CHAT} root`]: "served" }
      ),
      false,
    ],
  ] as const)(
    "flip evidence needs the cell `endpoint: legacy` dispatches to, a different one, to have accepted: %s",
    (_name, rows, evidence) => {
      const reason = failReason(rows);
      if (evidence) {
        expect(reason).toContain("(flip evidence");
      } else {
        expect(reason).not.toContain("(flip evidence");
        expect(reason).toContain(
          "(not flip evidence: no flip reaches that shape)"
        );
      }
    }
  );

  const CI_SECRET = "(not flip evidence: check the CI secret)";
  const KEY_UNMEASURED = "(not flip evidence: nothing else measured the key)";
  const FLIP_UNMEASURED =
    "(not flip evidence this run: the shape a flip reaches measured nothing; re-run)";
  const NO_FLIP_SERVES = "(not flip evidence: a flip would not serve it)";

  it.each([
    // A sibling that never read the key — a gone path, a rate limit, a busy
    // upstream — neither confirms nor vetoes the key's refusal: the reason is
    // read from the siblings that did read it.
    [
      "modern auth-refused, legacy refused the key, root path-gone",
      "auth-refused",
      { legacy: "auth-refused", root: "path-gone" },
      CI_SECRET,
    ],
    [
      "modern auth-refused, legacy refused the key, root rate-limited",
      "auth-refused",
      { legacy: "auth-refused", root: "rate-limited" },
      CI_SECRET,
    ],
    [
      "modern auth-refused, legacy refused the key, root upstream-busy",
      "auth-refused",
      { legacy: "auth-refused", root: "upstream-busy" },
      CI_SECRET,
    ],
    [
      "modern auth-refused, legacy path-gone, root refused the key",
      "auth-refused",
      { legacy: "path-gone", root: "auth-refused" },
      CI_SECRET,
    ],
    [
      "modern auth-refused, legacy rate-limited, root refused the key",
      "auth-refused",
      { legacy: "rate-limited", root: "auth-refused" },
      CI_SECRET,
    ],
    [
      "modern auth-refused, legacy upstream-busy, root path-gone",
      "auth-refused",
      { legacy: "upstream-busy", root: "path-gone" },
      KEY_UNMEASURED,
    ],
    // A protocol or a path is decided by the shape a flip reaches: when that
    // one measured nothing, the run names no cause.
    [
      "modern wrong-protocol, legacy rate-limited, root path-gone",
      "wrong-protocol",
      { legacy: "rate-limited", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern wrong-protocol, legacy upstream-busy, root path-gone",
      "wrong-protocol",
      { legacy: "upstream-busy", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern wrong-protocol, legacy transport-error, root wrong-protocol",
      "wrong-protocol",
      { legacy: "transport-error", root: "wrong-protocol" },
      FLIP_UNMEASURED,
    ],
    [
      "modern path-gone, legacy rate-limited, root path-gone",
      "path-gone",
      { legacy: "rate-limited", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern path-gone, legacy upstream-busy, root path-gone",
      "path-gone",
      { legacy: "upstream-busy", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern path-gone, legacy transport-error, root path-gone",
      "path-gone",
      { legacy: "transport-error", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern wrong-protocol, legacy path-gone, root rate-limited",
      "wrong-protocol",
      { legacy: "path-gone", root: "rate-limited" },
      NO_FLIP_SERVES,
    ],
    [
      "modern path-gone, legacy refused the key, root upstream-busy",
      "path-gone",
      { legacy: "auth-refused", root: "upstream-busy" },
      NO_FLIP_SERVES,
    ],
    // The account's gate answers before the format check and the model's
    // routing (protocol-routing.e2e.ts), so beside a refused protocol it
    // measured nothing; beside a refused key or a gone path it shows the key
    // was read and the path exists.
    [
      "modern wrong-protocol, legacy the account's",
      "wrong-protocol",
      { legacy: "account", root: "path-gone" },
      FLIP_UNMEASURED,
    ],
    [
      "modern path-gone, legacy the account's",
      "path-gone",
      { legacy: "account", root: "path-gone" },
      "(flip evidence",
    ],
    [
      "modern auth-refused, legacy the account's",
      "auth-refused",
      { legacy: "account", root: "path-gone" },
      "(flip evidence",
    ],
    [
      "modern wrong-protocol, root the account's only",
      "wrong-protocol",
      { legacy: "path-gone", root: "account" },
      NO_FLIP_SERVES,
    ],
  ] as const)(
    "a refusal is read from the siblings that measured it: %s",
    (_name, verdict, siblings, reason) => {
      const rows = withCells(plane([verdict, "served", "served", "served"]), {
        [`${ZEN_CHAT} legacy`]: siblings.legacy,
        [`${ZEN_CHAT} root`]: siblings.root,
      });
      const failed = failReason(rows);
      expect(failed).toContain(reason);
      for (const other of [
        CI_SECRET,
        KEY_UNMEASURED,
        FLIP_UNMEASURED,
        NO_FLIP_SERVES,
        "(flip evidence",
      ]) {
        if (other !== reason) {
          expect(failed).not.toContain(other);
        }
      }
    }
  );

  it("Go's Google, which no flip moves, is never a re-run: a flip would not serve it whatever its siblings answered", () => {
    const failed = failReason(
      plane(
        ["served", "served", "served", "path-gone"],
        "rate-limited",
        "opencode-go"
      )
    );
    expect(failed).toContain(NO_FLIP_SERVES);
    expect(failed).not.toContain(FLIP_UNMEASURED);
  });

  it("a flip target the run never probed measured nothing", () => {
    const rows = plane(["wrong-protocol", "served", "served", "served"]).filter(
      (row) => row.cell !== `${ZEN_CHAT} legacy`
    );
    expect(failReason(rows)).toContain(FLIP_UNMEASURED);
  });

  it.each([
    ["legacy", "account"],
    ["root", "account"],
  ] as const)(
    "a retired model beside the account's answer on %s fails nothing: the account's gate answers before the model is routed",
    (family, verdict) => {
      expect(
        planeOutcome(
          withCells(plane(["model-gone", "served", "served", "served"]), {
            [`${ZEN_CHAT} ${family}`]: verdict,
          })
        ).kind
      ).toBe("pass");
    }
  );

  it("a busy upstream and then no answer fails a default cell as unreadable, not as flip evidence", () => {
    const verdict = keyedVerdictOf([{ bodyText: "", status: 529 }, undefined]);
    expect(verdict).toBe("transport-error");
    const outcome = planeOutcome(
      plane(["served", verdict, "served", "served"])
    );
    expect(outcome.kind).toBe("fail");
    expect(outcome.kind === "fail" ? outcome.reason : "").toContain(
      "gave no readable answer (not flip evidence)"
    );
  });

  it("a failure names its rows and says whether it is flip evidence", () => {
    const evidence = planeOutcome(
      plane(["wrong-protocol", "served"], "served")
    );
    expect(evidence.kind).toBe("fail");
    if (evidence.kind === "fail") {
      expect(evidence.broken.map((row) => row.verdict)).toEqual([
        "wrong-protocol",
      ]);
      expect(evidence.reason).toContain("(flip evidence");
    }
    const unreadable = planeOutcome(plane(["other", "served"]));
    expect(unreadable.kind === "fail" ? unreadable.reason : "").toContain(
      "not flip evidence"
    );
    const skipped = planeOutcome(
      plane(["account", "rate-limited", "account", "account"])
    );
    expect(skipped.kind === "skip" ? skipped.reason : "").toContain(
      "account, rate-limited, account, account"
    );
  });
});

/** A GitHub Actions expression, `${{ inner }}`, as the workflow spells it. */
const expression = (inner: string): string =>
  ["$", "{{ ", inner, " }}"].join("");

describe("keyed probes · the CI wiring", () => {
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const start = ci.indexOf("\n  e2e:\n");
  const end = ci.indexOf("\n  e2e-host:");
  const job = ci.slice(start, end);
  /** The job's steps, split at each `- ` list item of its `steps:`. */
  const steps = job.split(/\n {6}- /u);
  const tierStep = steps.find((step) => step.includes("id: tier")) ?? "";
  const testStep =
    steps.find((step) => step.includes("run: pnpm run test:e2e")) ?? "";
  /** The scope pattern the tier step greps the changed paths with. */
  const scope = /grep -Eq '([^']+)'/u.exec(tierStep)?.[1];

  it("the job and its tier step are where this test looks", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(tierStep).toContain("id: tier");
    expect(job).toContain("fetch-depth: 0");
    expect(scope).toBeDefined();
  });

  it("the scope arms the probes on the host seam, the legacy URLs and protocols they send, the family the plugin dispatches to, the identity and anthropic-version they carry, and their own inputs, and on nothing else", () => {
    // The ERE is JavaScript-compatible, so the pattern CI runs is the one
    // tested here.
    const armed = new RegExp(scope ?? "(?!)", "u");
    for (const path of [
      "src/host/route-claim.ts",
      "src/host/nested/deep.ts",
      "src/utils/protocols.ts",
      "src/utils/plane-model.ts",
      "src/identity.ts",
      "src/utils/request-shape.ts",
      "test/e2e/keyed-probes.e2e.ts",
      "test/support/keyed-probes.ts",
      "test/support/keyless-matrix.ts",
      ".github/workflows/ci.yml",
    ]) {
      expect(armed.test(path), path).toBe(true);
    }
    for (const path of [
      "README.md",
      "docs/redirect-planes.md",
      "src/fetch-patch.ts",
      "src/hostile.ts",
      "src/utils/plane-model.test.ts",
      // Named as left out in the tier step: covered offline and nightly.
      "src/catalog-data.ts",
      "src/models-catalog.ts",
      "src/session.ts",
      "src/utils/request-shape.test.ts",
      "test/keyed-probes.test.ts",
      "test/support/keyed-probes.ts.bak",
      "x/src/host/a.ts",
    ]) {
      expect(armed.test(path), path).toBe(false);
    }
  });

  it("a match arms `probes` and a miss `none`; schedule and dispatch arm `full`", () => {
    expect(tierStep).toContain("schedule|workflow_dispatch) tier=full");
    // The arms in order: the grep, then `probes`, then `else`, then `none`.
    // grep reads a here-string: piped, `grep -q` exiting on an early match
    // can kill the writer with SIGPIPE, which pipefail reads as a miss.
    expect(tierStep).toMatch(
      /if grep -Eq '[^']+' <<<"\$changed"; then\n\s+tier=probes\n\s+else\n\s+tier=none\n\s+fi/u
    );
    expect(tierStep).not.toMatch(/\|\s*grep/u);
  });

  it("every event the job runs on but schedule, dispatch and a pull request arms `none`: a push to main spends no key", () => {
    const arms = [...tierStep.matchAll(/^\s+([^\s()]+)\)/gmu)].map(
      (match) => match[1]
    );
    expect(arms).toEqual(["schedule|workflow_dispatch", "pull_request", "*"]);
    expect(tierStep).toMatch(/\n\s+\*\) tier=none ;;\n\s+esac/u);
  });

  it("the record is published and uploaded on every outcome, from the directory the suites write to, under the names they write", () => {
    // The red run is the one that carries the flip evidence (§13), so the
    // two steps that keep the record run `if: always()`.
    const publish =
      steps.find((step) => step.includes("GITHUB_STEP_SUMMARY")) ?? "";
    const upload =
      steps.find((step) => step.includes("actions/upload-artifact")) ?? "";
    for (const step of [publish, upload]) {
      expect(step).toMatch(/^\s*if: always\(\)$/mu);
    }
    const dir = /OPENCODE_E2E_RECORD_DIR: (.+)$/mu.exec(testStep)?.[1];
    expect(dir).toBe(`${expression("runner.temp")}/endpoint-families`);
    expect(publish).toContain(`RECORD_DIR: ${dir ?? "<none>"}`);
    expect(upload).toContain(`path: ${dir ?? "<none>"}`);
    expect(upload).toContain("name: endpoint-families");
    // The publisher reads the two names the suites write.
    expect(publish).toMatch(/for file in keyless\.md keyed\.md; do/u);
    expect(liveSource("keyless-matrix.e2e.ts")).toContain(
      'join(dir, "keyless.md")'
    );
    expect(liveSource("keyed-probes.e2e.ts")).toContain(
      'join(dir, "keyed.md")'
    );
  });

  it("each suite rewrites its record right after it records a cell, so a job killed at its time limit keeps what it measured", () => {
    /** What follows each `recorded.push(…);` call, from its balanced close. */
    const afterEachPush = (source: string): string[] =>
      [...source.matchAll(/recorded\.push\(/gu)].map((match) => {
        let depth = 0;
        let index = match.index + match[0].length - 1;
        do {
          const char = source[index];
          if (char === "(") {
            depth += 1;
          } else if (char === ")") {
            depth -= 1;
          }
          index += 1;
        } while (depth > 0 && index < source.length);
        return source.slice(index, index + 80);
      });
    for (const [file, pushes] of [
      ["keyless-matrix.e2e.ts", 1],
      ["keyed-probes.e2e.ts", 2],
    ] as const) {
      const source = liveSource(file);
      const after = afterEachPush(source);
      expect(after, file).toHaveLength(pushes);
      for (const rest of after) {
        expect(rest, file).toMatch(/^;\s*await persist\(false\);/u);
      }
    }
    // The free probe's line is rewritten as soon as it is decided.
    expect(liveSource("keyless-matrix.e2e.ts")).toMatch(
      /\n\s*free = [^;]+;\s*await persist\(false\);/u
    );
  });

  it("the test step names the tier and passes the keys only when it is not `none`", () => {
    // Unset means `full`, so a step that dropped the tier line would arm the
    // full keyed suites on every pull request that arms the probes.
    for (const line of [
      `OPENCODE_E2E_KEYED: ${expression("steps.tier.outputs.keyed")}`,
      `OPENCODE_API_KEY: ${expression("steps.tier.outputs.keyed != 'none' && secrets.OPENCODE_API_KEY || ''")}`,
      `OPENCODE_GO_API_KEY: ${expression("steps.tier.outputs.keyed != 'none' && secrets.OPENCODE_GO_API_KEY || ''")}`,
      "OPENCODE_E2E_RECORD_DIR",
    ]) {
      expect(testStep, line).toContain(line);
    }
    // And no other step of the job sees a key.
    for (const step of steps) {
      if (step !== testStep) {
        expect(step).not.toContain("secrets.OPENCODE");
      }
    }
  });
});
