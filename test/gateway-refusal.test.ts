/**
 * The gateway's refusals, read off the failure text pi hands the host
 * (`src/utils/gateway-refusal.ts`, L2).
 *
 * Pure: a failure record in, a reclassified copy or `undefined` out. The text
 * table is pi 1.5.2's, measured over loopback for each protocol: completions
 * opens `403: `, Responses `<provider> API error (403): `, Anthropic `403 `,
 * and Google carries the body alone, with no status (a pi gap the module does
 * not fill, D26).
 *
 * @module test/gateway-refusal.test
 */
import { describe, expect, it } from "vitest";

import {
  classifyGatewayRefusal,
  FREE_TIER_CODE,
  GATEWAY_REFUSAL_CODES,
  leadingStatusOf,
  MODEL_UNAVAILABLE_CODE,
  reclassifyFinish,
  reclassifyRefusals,
  refusalTypeOf,
} from "./support/src.ts";

/** One refusal: its type, its status and the gateway's own body. */
interface Refusal {
  readonly type: string;
  readonly status: number;
  readonly body: string;
  readonly code: string;
}

/** The five refusal types, with the bodies and statuses the gateway sends. */
const REFUSALS: readonly Refusal[] = [
  {
    body: JSON.stringify({
      error: {
        message: "OpenCode's free tier can only be used from within OpenCode",
        type: "FreeTierError",
      },
    }),
    code: FREE_TIER_CODE,
    status: 403,
    type: "FreeTierError",
  },
  {
    body: JSON.stringify({
      error: {
        message: "Free usage limit reached. Free models work in OpenCode",
        type: "FreeUsageLimitError",
      },
    }),
    code: FREE_TIER_CODE,
    status: 429,
    type: "FreeUsageLimitError",
  },
  {
    body: JSON.stringify({
      error: {
        message: "This model is not available in your country.",
        type: "RegionError",
      },
    }),
    code: MODEL_UNAVAILABLE_CODE,
    status: 403,
    type: "RegionError",
  },
  {
    body: JSON.stringify({
      error: {
        message: "Model mimo-v2.5-pro has been deprecated.",
        type: "ModelDeprecated",
      },
      type: "error",
    }),
    code: MODEL_UNAVAILABLE_CODE,
    status: 410,
    type: "ModelDeprecated",
  },
  // `ModelDeprecated` is measured at 410 (`docs/upstream-findings.md`) and at
  // 400 (`docs/redirect-planes.md` §13); the probes hold it as gone at 404
  // too (`isModelDeprecated`), and the 404 fixture guards that rule: the type
  // decides the code, and the status is kept whichever it is.
  {
    body: JSON.stringify({
      error: {
        message: "Model mimo-v2.5-pro has been deprecated.",
        type: "ModelDeprecated",
      },
    }),
    code: MODEL_UNAVAILABLE_CODE,
    status: 400,
    type: "ModelDeprecated",
  },
  {
    body: JSON.stringify({
      error: {
        message: "Model mimo-v2.5-pro has been deprecated.",
        type: "ModelDeprecated",
      },
    }),
    code: MODEL_UNAVAILABLE_CODE,
    status: 404,
    type: "ModelDeprecated",
  },
  {
    body: JSON.stringify({
      error: {
        message: "ModelProtocolUnsupported: m is not served on this protocol",
        type: "ModelProtocolUnsupported",
      },
    }),
    code: MODEL_UNAVAILABLE_CODE,
    status: 400,
    type: "ModelProtocolUnsupported",
  },
];

/** pi 1.5.2's failure text per protocol, around the gateway's body. */
const FORMATS: readonly {
  readonly protocol: string;
  readonly text: (status: number, body: string) => string;
  readonly carriesStatus: boolean;
}[] = [
  {
    carriesStatus: true,
    protocol: "openai-completions",
    text: (status, body) => `${String(status)}: ${body}`,
  },
  {
    carriesStatus: true,
    protocol: "openai-responses",
    text: (status, body) => `opencode API error (${String(status)}): ${body}`,
  },
  {
    carriesStatus: true,
    protocol: "anthropic-messages",
    text: (status, body) => `${String(status)} ${body}`,
  },
  {
    carriesStatus: false,
    protocol: "google-generative-ai",
    text: (_status, body) => body,
  },
];

const CASES = REFUSALS.flatMap((refusal) =>
  FORMATS.map(
    (format) =>
      [
        `${refusal.type} ${String(refusal.status)}`,
        format.protocol,
        refusal,
        format,
      ] as const
  )
);

describe("gateway-refusal · the five refusal types", () => {
  it.each(CASES)(
    "classifies %s in %s's text, keeping pi's text and the status at its head",
    (_type, _protocol, refusal, format) => {
      const message = format.text(refusal.status, refusal.body);
      expect(refusalTypeOf(message)).toBe(refusal.type);
      const classified = classifyGatewayRefusal({ code: "AUTH", message });
      expect(classified).toEqual(
        format.carriesStatus
          ? { code: refusal.code, message, status: refusal.status }
          : { code: refusal.code, message }
      );
      expect(classified?.message).toBe(message);
    }
  );

  it("covers every type its code table names", () => {
    // The table and the cases above agree: no type is mapped but untested.
    expect(Object.keys(GATEWAY_REFUSAL_CODES).toSorted()).toEqual(
      [...new Set(REFUSALS.map((refusal) => refusal.type))].toSorted()
    );
  });
});

describe("gateway-refusal · what it leaves alone", () => {
  it("leaves every failure that names no refusal type alone", () => {
    for (const message of [
      '401: {"message":"Invalid API key","type":"AuthError"}',
      '429: {"message":"Too many requests","type":"rate_limit_error"}',
      '403: {"message":"Upstream request failed: Model access is disabled","type":"server_error"}',
      "400 This model's maximum context length is 128000 tokens.",
      // The gateway's untyped "Model is unavailable" (the probes read it as
      // model-gone) is outside L2's five types: the bridge's reading stays.
      '400: {"error":{"message":"Model is unavailable"}}',
      // A type token inside a longer word is not the type.
      "403: NotAFreeTierErrorAtAll",
    ]) {
      expect(classifyGatewayRefusal({ code: "AUTH", message })).toBeUndefined();
    }
    expect(classifyGatewayRefusal({ code: "AUTH" })).toBeUndefined();
    expect(
      classifyGatewayRefusal({ code: "AUTH", message: 403 })
    ).toBeUndefined();
    expect(refusalTypeOf("nothing here")).toBeUndefined();
  });

  it("reads a status only at the text's head", () => {
    expect(leadingStatusOf('403: {"type":"FreeTierError"}')).toBe(403);
    expect(leadingStatusOf("opencode-go API error (429): {}")).toBe(429);
    expect(leadingStatusOf('410 {"type":"error"}')).toBe(410);
    expect(leadingStatusOf('{"error":{"code":403}}')).toBeUndefined();
    expect(leadingStatusOf("upstream answered 403")).toBeUndefined();
    // Outside an HTTP status's range, or not a whole token.
    expect(leadingStatusOf("600: x")).toBeUndefined();
    expect(leadingStatusOf("4031: x")).toBeUndefined();
    expect(leadingStatusOf("403")).toBeUndefined();
  });

  it("keeps a failure's own numeric status over the text's", () => {
    const message = '403: {"type":"FreeTierError"}';
    expect(
      classifyGatewayRefusal({ code: "AUTH", message, status: 401 })
    ).toEqual({ code: FREE_TIER_CODE, message, status: 401 });
    // A status that is not a number is not one: the text's is read.
    expect(
      classifyGatewayRefusal({ code: "AUTH", message, status: "401" })
    ).toEqual({ code: FREE_TIER_CODE, message, status: 403 });
  });
});

/** A deep-frozen copy, as a host may hand its chunks over. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
};

describe("gateway-refusal · a stream's finish", () => {
  const message =
    '403: {"message":"OpenCode\'s free tier can only be used from within OpenCode","type":"FreeTierError"}';

  it("returns the same object for every chunk it does not reclassify", () => {
    const chunks: unknown[] = [
      undefined,
      "text",
      { text: "hi", type: "text-delta" },
      { reason: { kind: "aborted" }, type: "finish" },
      { reason: { kind: "error" }, type: "finish" },
      { reason: "error", type: "finish" },
      {
        reason: { failure: { code: "AUTH", message }, kind: "stop" },
        type: "finish",
      },
      {
        reason: {
          failure: { code: "AUTH", message: "401: Invalid API key" },
          kind: "error",
        },
        type: "finish",
      },
    ];
    for (const chunk of chunks) {
      expect(reclassifyFinish(chunk)).toBe(chunk);
    }
  });

  it("copies a frozen finish whose failure classifies, and leaves the input as it was", () => {
    const chunk = deepFreeze({
      reason: {
        failure: { code: "AUTH", message, retryable: false },
        kind: "error",
      },
      type: "finish",
      usage: { input: 1 },
    });
    const out = reclassifyFinish(chunk);
    expect(out).not.toBe(chunk);
    expect(out).toEqual({
      reason: {
        failure: {
          code: FREE_TIER_CODE,
          message,
          retryable: false,
          status: 403,
        },
        kind: "error",
      },
      type: "finish",
      usage: { input: 1 },
    });
    expect(chunk.reason.failure.code).toBe("AUTH");
  });

  it("yields every chunk in order, reclassifying the finish", async () => {
    const delta = { text: "hi", type: "text-delta" };
    async function* source(): AsyncGenerator {
      yield delta;
      yield {
        reason: { failure: { code: "AUTH", message }, kind: "error" },
        type: "finish",
      };
    }
    const out: unknown[] = [];
    for await (const chunk of reclassifyRefusals(source())) {
      out.push(chunk);
    }
    expect(out[0]).toBe(delta);
    expect(out[1]).toEqual({
      reason: {
        failure: { code: FREE_TIER_CODE, message, status: 403 },
        kind: "error",
      },
      type: "finish",
    });
  });

  it("closes the source when its consumer stops early", async () => {
    let closed = false;
    async function* source(): AsyncGenerator {
      try {
        yield { type: "text-delta" };
        yield { type: "text-delta" };
      } finally {
        closed = true;
      }
    }
    // What a `for await` that breaks after the first chunk does.
    const iterator = reclassifyRefusals(source())[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text-delta" });
    await iterator.return?.(undefined);
    expect(closed).toBe(true);
  });
});
