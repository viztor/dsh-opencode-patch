/**
 * The keyless probe matrix's cell table and classifier, offline.
 *
 * The live half (`test/e2e/keyless-matrix.e2e.ts`) cannot run in a sandbox
 * without the vendor's hosts, so everything it decides is decided here: which
 * sixteen URLs are probed, with which bodies, and how an answer is read. The
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
  classifyKeylessProbe,
  isFreeSpec,
  isModelGoneMessage,
  isTransientProbeAnswer,
  keylessMatrix,
  MATRIX_PROTOCOLS,
  type MatrixCell,
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
  it("is sixteen cells with exactly these URLs and models", () => {
    const cells = keylessMatrix({
      go: GO,
      isDeprecated: (plane, id) =>
        plane === "opencode" && id === "zen-old-resp",
      zen: ZEN,
    });
    expect(cells).toHaveLength(16);
    expect(
      Object.fromEntries(
        cells.map((cell) => [key(cell), [cell.url, cell.model]])
      )
    ).toEqual({
      "opencode openai-completions legacy": [
        "https://opencode.ai/zen/v1/chat/completions",
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
      "opencode openai-responses modern": [
        "https://opencode.ai/inference/openai/v1/responses",
        "zen-resp",
      ],
      "opencode anthropic-messages legacy": [
        "https://opencode.ai/zen/v1/messages",
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
      "opencode google-generative-ai modern": [
        "https://opencode.ai/inference/google/v1beta/models/zen-gemini:streamGenerateContent?alt=sse",
        "zen-gemini",
      ],
      "opencode-go openai-completions legacy": [
        "https://opencode.ai/zen/go/v1/chat/completions",
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
      "opencode-go openai-responses modern": [
        "https://opencode.ai/inference/go/openai/v1/responses",
        "go-resp",
      ],
      "opencode-go anthropic-messages legacy": [
        "https://opencode.ai/zen/go/v1/messages",
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
    expect(zenCells).toHaveLength(8);
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
      "opencode-go google-generative-ai modern",
    ]);
    for (const cell of missing) {
      expect(cell.body).toBeUndefined();
    }
  });

  it("on the bundled catalogs: sixteen cells, each the first PAID model of its protocol, and none can carry a key", () => {
    const cells = keylessMatrix({
      go: OPENCODE_GO_CATALOG,
      zen: OPENCODE_ZEN_CATALOG,
    });
    expect(cells).toHaveLength(16);
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
          (["legacy", "modern"] as const)
            .filter(
              (family) =>
                new URL(matrixUrl(plane, protocol, family, model)).pathname ===
                new URL(sent).pathname
            )
            .map((family) => cellKey({ family, plane, protocol }))
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
  ] as const)("%i %s → %s", (status, bodyText, verdict) => {
    expect(classifyKeylessProbe({ bodyText, status })).toBe(verdict);
  });
});

describe("a live turn's failure message that says the model is gone", () => {
  // The adapter blocks of the live e2e suites read this as a reason to ASK:
  // a raw probe of the same id decides whether the vendor withdrew it.
  it.each([
    ["410 status code (no body)", true],
    ["400 Upstream request failed: Model is unavailable", true],
    ["model is UNAVAILABLE", true],
    ["400 Invalid request: messages is required", false],
    ["4100 tokens exceeded", false],
    ["", false],
  ] as const)("%j → %s", (message, gone) => {
    expect(isModelGoneMessage(message)).toBe(gone);
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
