/**
 * The keyless probe matrix's cell table and classifier, offline.
 *
 * The live half (`test/e2e/keyless-matrix.e2e.ts`) cannot run in a sandbox
 * without the vendor's hosts, so everything it decides is decided here: which
 * twenty-four URLs are probed (three URL shapes), with which bodies, which
 * cells each `endpoint` setting dispatches to, which free model the keyless
 * free probe sends, and how each answer is read. The
 * URLs are written out from the vendor's endpoint layout, not derived from the
 * module, and the bundled-catalog case checks invariants rather than model
 * names, so the nightly catalog refresh cannot turn it red.
 *
 * @module test/keyless-matrix.test
 */
import { describe, expect, it } from "vitest";

import { PLANES, S0_TODAY } from "./support/host.ts";
import {
  cellKey,
  classifyFreeProbe,
  classifyKeylessProbe,
  freeProbeCells,
  freeProbeOutcome,
  goneDefaultRows,
  isFreeSpec,
  isTransientProbeAnswer,
  keylessMatrix,
  LEGACY_DISPATCH,
  MATRIX_FAMILIES,
  MATRIX_PROTOCOLS,
  type MatrixCell,
  type MatrixFamily,
  redirectPathOf,
  unreadRows,
  verdictOfAttempts,
  matrixUrl,
  TODAY_DISPATCH,
} from "./support/keyless-matrix.ts";
import {
  type CatalogModelSpec,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  protocolForSdk,
} from "./support/src.ts";

const spec = (
  id: string,
  provider_npm?: string,
  free = false
): CatalogModelSpec => ({
  context_window: 1000,
  id,
  input_modalities: ["text"],
  max_output_tokens: 100,
  name: id,
  ...(free ? { is_free: true } : {}),
  ...(provider_npm === undefined ? {} : { provider_npm }),
});

/**
 * One paid model per protocol on each plane, each behind a free one (flagged,
 * or only named `free`) and Zen's Responses model behind a retired one too.
 * A free model answers a keyless request with a real completion, so the cells
 * must never pick one.
 */
const ZEN = [
  spec("zen-beam", undefined, true),
  spec("zen-chat-free"),
  spec("zen-chat"),
  spec("zen-resp-free", "@ai-sdk/openai", true),
  spec("zen-old-resp", "@ai-sdk/openai"),
  spec("zen-resp", "@ai-sdk/openai"),
  spec("zen-claude-free", "@ai-sdk/anthropic", true),
  spec("zen-claude", "@ai-sdk/anthropic"),
  spec("zen-gemini-free", "@ai-sdk/google", true),
  spec("zen-gemini", "@ai-sdk/google"),
  spec("zen-mistral", "@ai-sdk/mistral"),
];
const GO = [
  spec("go-beam", undefined, true),
  spec("go-chat"),
  spec("go-resp-free", "@ai-sdk/openai"),
  spec("go-resp", "@ai-sdk/openai"),
  spec("go-claude", "@ai-sdk/anthropic"),
  spec("go-gemini-free", "@ai-sdk/google", true),
  spec("go-gemini", "@ai-sdk/google"),
];

const key = (cell: MatrixCell): string => cellKey(cell);

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

describe("keyless matrix · the cells", () => {
  it("is twenty-four cells over three URL shapes with exactly these URLs and models", () => {
    expect(MATRIX_FAMILIES).toEqual(["legacy", "root", "modern"]);
    const cells = keylessMatrix({
      go: GO,
      isDeprecated: (plane, id) =>
        plane === "opencode" && id === "zen-old-resp",
      zen: ZEN,
    });
    expect(cells).toHaveLength(24);
    // Plane, then protocol, then the three shapes in order.
    expect(cells.slice(0, 3).map(key)).toEqual([
      "opencode openai-completions legacy",
      "opencode openai-completions root",
      "opencode openai-completions modern",
    ]);
    expect(
      Object.fromEntries(
        cells.map((cell) => [key(cell), [cell.url, cell.model]])
      )
    ).toEqual({
      "opencode openai-completions legacy": [
        "https://opencode.ai/zen/v1/chat/completions",
        "zen-chat",
      ],
      "opencode openai-completions root": [
        "https://opencode.ai/inference/v1/chat/completions",
        "zen-chat",
      ],
      "opencode openai-completions modern": [
        "https://opencode.ai/inference/openai/v1/chat/completions",
        "zen-chat",
      ],
      "opencode openai-responses legacy": [
        "https://opencode.ai/zen/v1/responses",
        "zen-resp",
      ],
      "opencode openai-responses root": [
        "https://opencode.ai/inference/v1/responses",
        "zen-resp",
      ],
      "opencode openai-responses modern": [
        "https://opencode.ai/inference/openai/v1/responses",
        "zen-resp",
      ],
      "opencode anthropic-messages legacy": [
        "https://opencode.ai/zen/v1/messages",
        "zen-claude",
      ],
      "opencode anthropic-messages root": [
        "https://opencode.ai/inference/v1/messages",
        "zen-claude",
      ],
      "opencode anthropic-messages modern": [
        "https://opencode.ai/inference/anthropic/v1/messages",
        "zen-claude",
      ],
      "opencode google-generative-ai legacy": [
        "https://opencode.ai/zen/v1/models/zen-gemini:streamGenerateContent?alt=sse",
        "zen-gemini",
      ],
      "opencode google-generative-ai root": [
        "https://opencode.ai/inference/v1/models/zen-gemini:streamGenerateContent?alt=sse",
        "zen-gemini",
      ],
      "opencode google-generative-ai modern": [
        "https://opencode.ai/inference/google/v1beta/models/zen-gemini:streamGenerateContent?alt=sse",
        "zen-gemini",
      ],
      "opencode-go openai-completions legacy": [
        "https://opencode.ai/zen/go/v1/chat/completions",
        "go-chat",
      ],
      "opencode-go openai-completions root": [
        "https://opencode.ai/inference/go/v1/chat/completions",
        "go-chat",
      ],
      "opencode-go openai-completions modern": [
        "https://opencode.ai/inference/go/openai/v1/chat/completions",
        "go-chat",
      ],
      "opencode-go openai-responses legacy": [
        "https://opencode.ai/zen/go/v1/responses",
        "go-resp",
      ],
      "opencode-go openai-responses root": [
        "https://opencode.ai/inference/go/v1/responses",
        "go-resp",
      ],
      "opencode-go openai-responses modern": [
        "https://opencode.ai/inference/go/openai/v1/responses",
        "go-resp",
      ],
      "opencode-go anthropic-messages legacy": [
        "https://opencode.ai/zen/go/v1/messages",
        "go-claude",
      ],
      "opencode-go anthropic-messages root": [
        "https://opencode.ai/inference/go/v1/messages",
        "go-claude",
      ],
      "opencode-go anthropic-messages modern": [
        "https://opencode.ai/inference/go/anthropic/v1/messages",
        "go-claude",
      ],
      "opencode-go google-generative-ai legacy": [
        "https://opencode.ai/zen/go/v1/models/go-gemini:streamGenerateContent",
        "go-gemini",
      ],
      "opencode-go google-generative-ai root": [
        "https://opencode.ai/inference/go/v1/models/go-gemini:streamGenerateContent?alt=sse",
        "go-gemini",
      ],
      "opencode-go google-generative-ai modern": [
        "https://opencode.ai/inference/go/google/v1beta/models/go-gemini:streamGenerateContent?alt=sse",
        "go-gemini",
      ],
    });
  });

  it("carries the model in the body for the three body-addressed protocols, and the smallest output budget", () => {
    const cells = keylessMatrix({ go: GO, zen: ZEN });
    const zen = (protocol: string, family: string) =>
      cells.find(
        (cell) =>
          cell.plane === "opencode" &&
          cell.protocol === protocol &&
          cell.family === family
      );
    expect(zen("openai-completions", "modern")?.body).toEqual({
      max_tokens: 1,
      messages: [{ content: "hi", role: "user" }],
      model: "zen-chat",
    });
    expect(zen("openai-responses", "legacy")?.body).toEqual({
      input: "hi",
      max_output_tokens: 1,
      model: "zen-old-resp",
    });
    expect(zen("anthropic-messages", "modern")?.body).toEqual({
      max_tokens: 1,
      messages: [{ content: "hi", role: "user" }],
      model: "zen-claude",
    });
    expect(zen("google-generative-ai", "modern")?.body).toEqual({
      contents: [{ parts: [{ text: "hi" }], role: "user" }],
      generationConfig: { maxOutputTokens: 1 },
    });
    expect(zen("anthropic-messages", "legacy")?.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(zen("openai-completions", "legacy")?.headers).toEqual({
      "content-type": "application/json",
    });
  });

  it("never picks a free model, flagged or only named so", () => {
    const cells = keylessMatrix({ go: GO, zen: ZEN });
    const all = [...ZEN, ...GO];
    for (const cell of cells) {
      const picked = all.find((entry) => entry.id === cell.model);
      expect(picked, key(cell)).toBeDefined();
      expect(picked?.is_free, key(cell)).not.toBe(true);
      expect(cell.model, key(cell)).not.toMatch(/free/iu);
    }
    // A plane whose only model for a protocol is free has no cell model.
    const onlyFree = keylessMatrix({
      go: GO,
      zen: [spec("zen-beam", undefined, true)],
    });
    const zenCells = onlyFree.filter((cell) => cell.plane === "opencode");
    expect(zenCells).toHaveLength(12);
    expect(zenCells.filter((cell) => cell.model !== undefined)).toEqual([]);
    expect(isFreeSpec(spec("paid"))).toBe(false);
    expect(isFreeSpec(spec("x", undefined, true))).toBe(true);
    expect(isFreeSpec(spec("big-FREE-model"))).toBe(true);
  });

  it("reports a protocol a plane has no model for as a model-less, body-less cell", () => {
    const cells = keylessMatrix({
      go: GO.filter((entry) => entry.provider_npm !== "@ai-sdk/google"),
      zen: ZEN,
    });
    const missing = cells.filter((cell) => cell.model === undefined);
    expect(missing.map(key)).toEqual([
      "opencode-go google-generative-ai legacy",
      "opencode-go google-generative-ai root",
      "opencode-go google-generative-ai modern",
    ]);
    for (const cell of missing) {
      expect(cell.body).toBeUndefined();
    }
  });

  it("on the bundled catalogs: twenty-four cells, each the first PAID model of its protocol, and none can carry a key", () => {
    const cells = keylessMatrix({
      go: OPENCODE_GO_CATALOG,
      zen: OPENCODE_ZEN_CATALOG,
    });
    expect(cells).toHaveLength(24);
    for (const cell of cells) {
      const catalog =
        cell.plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;
      const first = catalog.find(
        (entry) =>
          protocolForSdk(entry.provider_npm) === cell.protocol &&
          entry.is_free !== true &&
          !/free/iu.test(entry.id)
      );
      expect(cell.model, key(cell)).toBe(first?.id);
      expect(cell.model, key(cell)).toBeDefined();
      expect(
        catalog.find((entry) => entry.id === cell.model)?.is_free,
        key(cell)
      ).not.toBe(true);
      if (cell.protocol === "google-generative-ai") {
        expect(cell.url).toContain(
          `/models/${cell.model}:streamGenerateContent`
        );
      } else {
        expect(cell.body?.model).toBe(cell.model);
      }
      expect(cell.method).toBe("POST");
      expect(
        Object.keys(cell.headers).filter((header) =>
          CREDENTIAL_HEADERS.has(header.toLowerCase())
        )
      ).toEqual([]);
      expect(new URL(cell.url).hostname).toBe("opencode.ai");
    }
  });
});

describe("keyless matrix · the cells the live run asserts", () => {
  it("TODAY_DISPATCH is exactly the cells S0_TODAY's measured turns were sent to", () => {
    // Each URL a characterized turn sent is matched to the one cell whose PATH
    // it is (the query aside: Messages adds `?beta=true`), with the row's own
    // model in the Google path. A row that sent nothing adds nothing.
    const reached = new Set<string>();
    for (const [rowKey, row] of Object.entries(S0_TODAY.rows)) {
      const slash = rowKey.indexOf("/");
      const plane = rowKey.slice(0, slash) as (typeof PLANES)[number];
      const model = rowKey.slice(slash + 1);
      expect(PLANES, rowKey).toContain(plane);
      for (const sent of row.sent) {
        const matches = MATRIX_PROTOCOLS.flatMap((protocol) =>
          MATRIX_FAMILIES.filter(
            (family) =>
              new URL(matrixUrl(plane, protocol, family, model)).pathname ===
              new URL(sent).pathname
          ).map((family) => cellKey({ family, plane, protocol }))
        );
        expect(matches, `${rowKey} ${sent}`).toHaveLength(1);
        reached.add(matches[0] ?? "");
      }
    }
    expect([...reached].toSorted()).toEqual([...TODAY_DISPATCH].toSorted());
    // Every protocol on both planes reaches the modern family, completions
    // included (P-R1), and nothing reaches a legacy cell by default.
    expect([...TODAY_DISPATCH].toSorted()).toEqual(
      PLANES.flatMap((plane) =>
        MATRIX_PROTOCOLS.map((protocol) => `${plane} ${protocol} modern`)
      ).toSorted()
    );
    expect(
      [...TODAY_DISPATCH].filter((cell) => cell.endsWith("legacy"))
    ).toEqual([]);
    const all = new Set(keylessMatrix({ go: GO, zen: ZEN }).map(key));
    for (const cell of TODAY_DISPATCH) {
      expect(all.has(cell), cell).toBe(true);
    }
  });
});

describe("keyless matrix · the cells endpoint: legacy dispatches to", () => {
  it("LEGACY_DISPATCH is the legacy cell of every plane × protocol, but Go's Google stays on its modern cell", () => {
    expect([...LEGACY_DISPATCH].toSorted()).toEqual(
      [
        "opencode openai-completions legacy",
        "opencode openai-responses legacy",
        "opencode anthropic-messages legacy",
        "opencode google-generative-ai legacy",
        "opencode-go openai-completions legacy",
        "opencode-go openai-responses legacy",
        "opencode-go anthropic-messages legacy",
        "opencode-go google-generative-ai modern",
      ].toSorted()
    );
    const all = new Set(keylessMatrix({ go: GO, zen: ZEN }).map(key));
    for (const cell of LEGACY_DISPATCH) {
      expect(all.has(cell), cell).toBe(true);
    }
    // The one cell both settings share is Go's Google (`GO_GOOGLE_BASE_URL`).
    expect(
      [...LEGACY_DISPATCH].filter((cell) => TODAY_DISPATCH.has(cell))
    ).toEqual(["opencode-go google-generative-ai modern"]);
  });
});

describe("keyless matrix · the free probe", () => {
  it("the free probe: every free completions model, on the default completions path, keyless, in catalog order", () => {
    const cells = freeProbeCells(ZEN);
    expect(cells.map((cell) => cell.model)).toEqual([
      "zen-beam",
      "zen-chat-free",
    ]);
    for (const cell of cells) {
      expect(cell.url).toBe(
        "https://opencode.ai/inference/openai/v1/chat/completions"
      );
      expect(cell.plane).toBe("opencode");
      expect(cell.protocol).toBe("openai-completions");
      expect(cell.family).toBe("modern");
      expect(cell.method).toBe("POST");
      expect(cell.body).toEqual({
        max_tokens: 1,
        messages: [{ content: "hi", role: "user" }],
        model: cell.model,
      });
      expect(cell.headers).toEqual({ "content-type": "application/json" });
    }
    expect(freeProbeCells([spec("paid")])).toEqual([]);

    const bundled = freeProbeCells(OPENCODE_ZEN_CATALOG);
    expect(bundled.length).toBeGreaterThan(0);
    for (const cell of bundled) {
      const row = OPENCODE_ZEN_CATALOG.find((entry) => entry.id === cell.model);
      expect(row, cell.model).toBeDefined();
      expect(row !== undefined && isFreeSpec(row), cell.model).toBe(true);
      expect(protocolForSdk(row?.provider_npm), cell.model).toBe(
        "openai-completions"
      );
      expect(
        Object.keys(cell.headers).filter((header) =>
          CREDENTIAL_HEADERS.has(header.toLowerCase())
        )
      ).toEqual([]);
    }
  });

  it.each([
    [200, '{"choices":[]}', "served"],
    [403, '{"error":{"type":"FreeTierError"}}', "free-tier-gated"],
    [
      401,
      "ModelError: model x not supported for format oa-compat",
      "wrong-format",
    ],
    [401, '{"error":{"type":"AuthError"}}', "auth-required"],
    [403, "", "auth-required"],
    [404, "", "path-gone"],
    [410, "", "model-gone"],
    [400, "Model is unavailable", "model-gone"],
    [500, "", "other"],
    [400, '{"error":{"message":"max_tokens too small"}}', "other"],
    [401, '{"error":{"type":"FreeTierError"}}', "auth-required"],
    [302, "", "redirected"],
  ] as const)("a free probe's %i %s → %s", (status, bodyText, verdict) => {
    expect(classifyFreeProbe({ bodyText, status })).toBe(verdict);
  });

  const answer = (status: number, bodyText = "") => ({ bodyText, status });

  it.each([
    ["served", [answer(200, '{"choices":[]}')], "pass"],
    [
      "gated by the free tier",
      [answer(403, '{"error":{"type":"FreeTierError"}}')],
      "pass",
    ],
    [
      "429, then no answer (the measured rate-limit hang)",
      [answer(429), undefined],
      "skip",
    ],
    ["429, then 429", [answer(429), answer(429)], "skip"],
    ["429, then served", [answer(429), answer(200)], "pass"],
    ["no answer, twice", [undefined, undefined], "fail"],
    ["500, then 500", [answer(500), answer(500)], "fail"],
    ["path gone", [answer(404)], "fail"],
    ["a key demanded", [answer(401, '{"error":{"type":"AuthError"}}')], "fail"],
    [
      "the wrong wire format",
      [answer(401, "not supported for format oa-compat")],
      "fail",
    ],
    ["a redirect", [answer(307)], "fail"],
    ["the last candidate retired", [answer(410)], "fail"],
  ] as const)("the free probe: %s → %s", (_name, attempts, outcome) => {
    expect(
      freeProbeOutcome(verdictOfAttempts(attempts, classifyFreeProbe))
    ).toBe(outcome);
  });
});

describe("keyless matrix · reading the attempts and the redirects", () => {
  const answer = (status: number, bodyText = "") => ({ bodyText, status });

  it.each([
    ["one 401", [answer(401)], "path-exists"],
    ["429, then no answer", [answer(429), undefined], "rate-limited"],
    ["429, then 429", [answer(429), answer(429)], "rate-limited"],
    ["429, then 404", [answer(429), answer(404)], "path-gone"],
    ["no answer, twice", [undefined, undefined], "transport-error"],
    ["503, then no answer", [answer(503), undefined], "transport-error"],
    ["500, then 500", [answer(500), answer(500)], "other"],
    ["no attempt at all", [], "transport-error"],
  ] as const)("%s → %s", (_name, attempts, verdict) => {
    expect(verdictOfAttempts(attempts, classifyKeylessProbe)).toBe(verdict);
  });

  it("a redirect's path, resolved against the URL sent, without its host or query", () => {
    const sent = "https://opencode.ai/zen/v1/chat/completions";
    expect(redirectPathOf("/inference/openai/v1/chat/completions", sent)).toBe(
      "/inference/openai/v1/chat/completions"
    );
    expect(
      redirectPathOf("https://elsewhere.example/x/y?token=secret", sent)
    ).toBe("/x/y");
    expect(redirectPathOf("../responses", sent)).toBe("/zen/v1/responses");
    expect(redirectPathOf(null, sent)).toBeUndefined();
    expect(redirectPathOf("", sent)).toBeUndefined();
    expect(redirectPathOf("http://[bad", sent)).toBeUndefined();
  });
});

describe("keyless matrix · what the live matrix asserts", () => {
  const row = (cell: string, verdict: string) => ({
    cell,
    family: cell.split(" ")[2] as MatrixFamily,
    verdict,
  });

  it("an unreadable answer fails on a legacy or modern cell, never on a root one", () => {
    const rows = [
      row("opencode openai-completions legacy", "path-exists"),
      row("opencode openai-completions root", "other"),
      row("opencode openai-completions modern", "path-gone"),
      row("opencode openai-responses legacy", "other"),
      row("opencode openai-responses root", "transport-error"),
      row("opencode openai-responses modern", "model-gone"),
      row("opencode anthropic-messages legacy", "transport-error"),
      row("opencode anthropic-messages root", "redirected"),
      row("opencode anthropic-messages modern", "redirected"),
      row("opencode google-generative-ai legacy", "rate-limited"),
      row("opencode google-generative-ai modern", "no-model"),
    ];
    expect(unreadRows(rows).map((entry) => entry.cell)).toEqual([
      "opencode openai-responses legacy",
      "opencode anthropic-messages legacy",
      "opencode anthropic-messages modern",
      "opencode google-generative-ai legacy",
      "opencode google-generative-ai modern",
    ]);
  });

  it("only a default cell's path-gone breaks the default; a legacy or root one is recorded", () => {
    const rows = [
      row("opencode openai-completions legacy", "path-gone"),
      row("opencode openai-completions root", "path-gone"),
      row("opencode openai-completions modern", "path-exists"),
      row("opencode-go anthropic-messages modern", "path-gone"),
      row("opencode-go google-generative-ai modern", "model-gone"),
    ];
    expect(goneDefaultRows(rows).map((entry) => entry.cell)).toEqual([
      "opencode-go anthropic-messages modern",
    ]);
    expect(goneDefaultRows(rows.slice(0, 3))).toEqual([]);
  });
});

describe("keyless matrix · reading an answer", () => {
  it.each([
    [404, "", "path-gone"],
    [401, '{"error":{"type":"AuthError"}}', "path-exists"],
    [403, "", "path-exists"],
    [410, "", "model-gone"],
    [400, '{"error":{"message":"Model is unavailable"}}', "model-gone"],
    [400, "model is UNAVAILABLE for this plan", "model-gone"],
    [400, "Invalid API key", "path-exists"],
    [200, "{}", "other"],
    [500, "", "other"],
    [301, "", "redirected"],
    [308, "", "redirected"],
  ] as const)("%i %s → %s", (status, bodyText, verdict) => {
    expect(classifyKeylessProbe({ bodyText, status })).toBe(verdict);
  });
});

describe("keyless matrix · a transient answer is retried once", () => {
  it.each([
    [undefined, true],
    [429, true],
    [500, true],
    [503, true],
    [401, false],
    [404, false],
    [400, false],
    [200, false],
  ] as const)("%s → %s", (status, retry) => {
    expect(isTransientProbeAnswer(status)).toBe(retry);
  });
});
