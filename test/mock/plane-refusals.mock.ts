/**
 * The gateway's refusals, as a plane turn finishes them (L2).
 *
 * The gateway refuses a turn it will not serve with a typed body:
 * `FreeTierError` (403) and `FreeUsageLimitError` (429) for the free tier,
 * `RegionError` (403), `ModelDeprecated` (410) and `ModelProtocolUnsupported`
 * (400) for the model. On pi-ai's own route the host's classifier reads those
 * by status and words, as AUTH, QUOTA, PI_AI_ERROR or INVALID_REQUEST, and the
 * conversation replaces an AUTH or QUOTA failure's message with its own
 * ("API key is invalid", "Request quota exhausted."), so the gateway's words
 * never reach the person (`test/mock/refusal-classification.mock.ts` pins that
 * route). On the planes the plugin serves, the turn finishes with the
 * refusal's own code, `FREE_TIER` or `MODEL_UNAVAILABLE`, and the gateway's
 * words and status (none on Google, whose text pi leaves without one;
 * `src/utils/gateway-refusal.ts`).
 *
 * The host is tier A with the plugin mounted, as in `plane-dispatch.mock.ts`:
 * each turn goes through the real `LlmRuntime`, the `PlaneAdapter` and pi's
 * protocol SDK to the mock gateway, which answers the case's refusal once its
 * own checks (credential, session band, protocol) have passed. The models are
 * the catalog's own (`fixtureModel`), one per protocol.
 *
 * @module test/mock/plane-refusals.mock
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  adaptersOf,
  fakeCredentials,
  type HostLlm,
  mountTierA,
  type TierA,
  waitForPlaneOwner,
} from "../support/host.ts";
import {
  clearCapturedApiKeys,
  FREE_TIER_CODE,
  MODEL_UNAVAILABLE_CODE,
} from "../support/src.ts";
import { urlOf } from "../test-helpers.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import { fixtureModel, GO_KEY, ZEN_KEY } from "./helpers.ts";
import {
  errorReply,
  FREE_TIER_MESSAGE,
  type MockReply,
} from "./opencode-gateway.ts";

type Plane = "opencode" | "opencode-go";

/** One refusal the gateway sends, with the code a plane turn finishes with. */
interface Refusal {
  readonly type: string;
  readonly status: number;
  readonly reply: MockReply;
  /** The gateway's own words, which the finish must keep. */
  readonly words: string;
  readonly code: string;
}

const FREE_USAGE_MESSAGE =
  "Free usage limit reached. Free models work in OpenCode";
const REGION_MESSAGE = "This model is not available in your country.";

/** The five refusals, each in the shape the gateway sends it. */
const REFUSALS: readonly Refusal[] = [
  {
    code: FREE_TIER_CODE,
    reply: errorReply(403, FREE_TIER_MESSAGE, "FreeTierError"),
    status: 403,
    type: "FreeTierError",
    words: "can only be used from within OpenCode",
  },
  {
    code: FREE_TIER_CODE,
    reply: errorReply(429, FREE_USAGE_MESSAGE, "FreeUsageLimitError"),
    status: 429,
    type: "FreeUsageLimitError",
    words: "Free usage limit reached",
  },
  {
    code: MODEL_UNAVAILABLE_CODE,
    reply: errorReply(403, REGION_MESSAGE, "RegionError"),
    status: 403,
    type: "RegionError",
    words: "not available in your country",
  },
  {
    code: MODEL_UNAVAILABLE_CODE,
    // The Anthropic-shaped envelope the gateway answers a retired id with
    // (`docs/upstream-findings.md`).
    reply: {
      body: JSON.stringify({
        error: {
          message: "Model retired-model has been deprecated.",
          type: "ModelDeprecated",
        },
        type: "error",
      }),
      contentType: "application/json",
      status: 410,
    },
    status: 410,
    type: "ModelDeprecated",
    words: "has been deprecated",
  },
  {
    code: MODEL_UNAVAILABLE_CODE,
    reply: errorReply(
      400,
      "ModelProtocolUnsupported: this model is not served on this endpoint",
      "model_protocol_unsupported"
    ),
    status: 400,
    type: "ModelProtocolUnsupported",
    words: "is not served on this endpoint",
  },
];

/** One model per protocol on Zen, and Go's completions. */
const SUBJECTS: readonly {
  readonly plane: Plane;
  readonly protocol: string;
  readonly model: string;
}[] = [
  ...[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ].map((protocol) => ({
    model: fixtureModel("opencode", protocol, "paid").id,
    plane: "opencode" as const,
    protocol,
  })),
  {
    model: fixtureModel("opencode-go", "openai-completions", "paid").id,
    plane: "opencode-go",
    protocol: "openai-completions",
  },
];

/** Each plane's profile: its key, and the subjects it declares. */
const PROVIDERS = {
  opencode: {
    apiKeyEnv: "OPENCODE_API_KEY",
    models: SUBJECTS.filter((subject) => subject.plane === "opencode").map(
      (subject) => ({ id: subject.model })
    ),
  },
  "opencode-go": {
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    models: SUBJECTS.filter((subject) => subject.plane === "opencode-go").map(
      (subject) => ({ id: subject.model })
    ),
  },
};

/** The reply every model request gets; `undefined` serves the fixture. */
let refusal: MockReply | undefined;
let gateway: MockGateway;
let tier: TierA | undefined;
let llm: HostLlm;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  gateway = await startMockGateway({
    behavior: (request) =>
      request.kind === "completions" ||
      request.kind === "responses" ||
      request.kind === "messages" ||
      request.kind === "google"
        ? refusal
        : undefined,
  });
  vi.spyOn(console, "info").mockImplementation(() => {
    // Silenced: the activation line.
  });
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith("https://opencode.ai/")) {
      return realFetch(
        url.replace("https://opencode.ai", gateway.origin),
        init
      );
    }
    return Promise.reject(
      new TypeError(`plane-refusals: refused a request to ${url}`)
    );
  }) as typeof fetch);
  tier = await mountTierA({
    credentials: fakeCredentials({
      refs: { OPENCODE_API_KEY: ZEN_KEY, OPENCODE_GO_API_KEY: GO_KEY },
    }),
    plugin: {},
    providers: PROVIDERS,
  });
  await waitForPlaneOwner(tier.llm, ["opencode", "opencode-go"]);
  ({ llm } = tier);
});

afterAll(async () => {
  await tier?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
  refusal = undefined;
  clearCapturedApiKeys();
});

afterEach(() => {
  refusal = undefined;
});

/** A finish's failure, as far as these cases read it. */
interface Failure {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}

/** One turn through the host's stream path; answers its finish. */
const finishOf = async (
  plane: Plane,
  model: string
): Promise<{ kind?: string; failure?: Failure }> => {
  let finish: { kind?: string; failure?: Failure } | undefined;
  for await (const chunk of llm.stream({
    messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    model,
    provider: plane,
    sessionId: "plane-refusals-session",
    signal: AbortSignal.timeout(10_000),
  } as never)) {
    const typed = chunk as {
      type: string;
      reason?: { kind?: string; failure?: Failure };
    };
    if (typed.type === "finish") {
      finish = typed.reason;
    }
  }
  if (finish === undefined) {
    throw new Error(`${plane}/${model}: the turn sent no finish`);
  }
  return finish;
};

/** The model requests the gateway saw. */
const modelRequests = (): number =>
  gateway.requests.filter(
    (request) =>
      request.kind !== "models" &&
      request.kind !== "usage" &&
      request.kind !== null
  ).length;

/** The codes the plane's adapter row retries. */
const retryableOf = (plane: Plane): readonly string[] =>
  (
    adaptersOf(llm).get(plane)?.retryPolicy as
      | { retryableCodes?: readonly string[] }
      | undefined
  )?.retryableCodes ?? [];

const CASES = REFUSALS.flatMap((entry) =>
  SUBJECTS.map(
    (subject) =>
      [
        entry.type,
        `${subject.plane} ${subject.protocol}`,
        entry,
        subject,
      ] as const
  )
);

describe("plane refusals · the gateway's five refusal types", () => {
  it.each(CASES)(
    "%s on %s: the turn finishes as the refusal's own code with the gateway's words and status, after one dispatch, its code outside the plane's retryable codes",
    async (_type, label, entry, subject) => {
      refusal = entry.reply;
      const finish = await finishOf(subject.plane, subject.model);
      expect(finish.kind, label).toBe("error");
      expect(finish.failure?.code, label).toBe(entry.code);
      expect(finish.failure?.message, label).toContain(entry.type);
      expect(finish.failure?.message, label).toContain(entry.words);
      // pi's Google text carries no status (a host gap, D26), so a Google
      // refusal finishes with its code and words and no status.
      expect(finish.failure?.status, label).toBe(
        subject.protocol === "google-generative-ai" ? undefined : entry.status
      );
      // One dispatch, no duplicate. This says nothing about retrying: that is
      // dsh-llm-retry's, which tier A does not mount, and it resends only a
      // code in the plane's `retryableCodes`, the assertion below.
      expect(modelRequests(), label).toBe(1);
      expect(gateway.requests.at(-1)?.status, label).toBe(entry.status);
      expect(retryableOf(subject.plane), label).not.toContain(entry.code);
    }
  );
});

describe("plane refusals · what keeps the host's own reading", () => {
  const [completions] = SUBJECTS;

  it("a refusal outside the gateway's five types keeps the host's own reading", async () => {
    if (completions === undefined) {
      throw new Error("no completions subject");
    }
    refusal = errorReply(401, "Invalid API key", "AuthError");
    const auth = await finishOf(completions.plane, completions.model);
    expect(auth.kind).toBe("error");
    expect(auth.failure?.code).toBe("AUTH");
    refusal = errorReply(429, "Too many requests", "rate_limit_error");
    const limited = await finishOf(completions.plane, completions.model);
    expect(limited.kind).toBe("error");
    expect(limited.failure?.code).toBe("RATE_LIMIT");
    expect(retryableOf(completions.plane)).toContain("RATE_LIMIT");
  });
});
