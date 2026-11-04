/**
 * The fetch patch's pure decisions, one branch at a time.
 *
 * Every case here was previously unreachable: the six functions were private
 * inside `fetch-patch.ts`, so their branches only ran when some integration path
 * happened to take them. That is the difference between covered and testable.
 *
 * @module test/request-shape.test
 */
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_VERSION,
  INTERNAL_ROUTES,
  authHeaderFor,
  catalogPlaneForRoute,
  gatewayPlaneFor,
  headerSourceOf,
  isGoPlaneUrl,
  isZenProvider,
  modelIdOf,
  requestUrlOf,
  toolNamesOf,
} from "./support/src.ts";

describe("request-shape · isZenProvider", () => {
  it("request-shape · isZenProvider: the Zen Google route is Zen, the Go routes are Go", () => {
    // `opencode-google` is the Zen plane's Google route. It starts with
    // `opencode-go`, so a predicate that looked for `go` anywhere read it as the
    // subscription plan; the plane is `opencode-go` or one of its own
    // `opencode-go-*` routes, and nothing else.
    expect(isZenProvider("opencode-google")).toBe(true);
    expect(isZenProvider("opencode-go-google")).toBe(false);
    expect(isZenProvider("opencode-go-responses")).toBe(false);
    expect(isZenProvider("opencode-go-anthropic")).toBe(false);
    expect(isZenProvider("opencode-go")).toBe(false);
    expect(isZenProvider("OpenCode-Go")).toBe(false);
    expect(isZenProvider("opencode")).toBe(true);
    expect(isZenProvider("OPENCODE")).toBe(true);
    expect(isZenProvider("opencode-anthropic")).toBe(true);
    expect(isZenProvider("opencode-responses")).toBe(true);
    expect(isZenProvider("deepseek")).toBe(false);
    expect(isZenProvider()).toBe(false);
  });

  it("agrees with catalogPlaneForRoute on every route the plugin serves", () => {
    // The defect was these two predicates disagreeing; a route added to or
    // renamed in responses-routes.ts must not let them drift apart again. The
    // set is bounded on purpose: outside OpenCode routes the two differ by
    // design (isZenProvider wants an `opencode` name; the plane defaults).
    const routes = ["opencode", "opencode-go", ...INTERNAL_ROUTES];
    expect(routes.length).toBeGreaterThan(2);
    for (const route of routes) {
      expect(isZenProvider(route), route).toBe(
        catalogPlaneForRoute(route) === "zen"
      );
    }
  });
});

describe("request-shape · the plane of a path", () => {
  it("reads the Go plane out of both endpoint families", () => {
    // The Go plane moved to the `inference` family, and three places ask this
    // question — the model listing's plane, a discovery request's plane, and
    // the tier a captured key belongs to. Each had its own answer, and each
    // answer was partial, so the question is asked once here.
    expect(isGoPlaneUrl("https://opencode.ai/zen/go/v1/models")).toBe(true);
    expect(
      isGoPlaneUrl("https://opencode.ai/inference/go/openai/v1/models")
    ).toBe(true);
    expect(
      isGoPlaneUrl("https://opencode.ai/inference/go/google/v1beta/models")
    ).toBe(true);
    // A relay's own Go route, under someone else's host.
    expect(
      isGoPlaneUrl("https://relay.example.com/go/v1/chat/completions")
    ).toBe(true);
  });

  it("does not read the Zen google family as the Go plane", () => {
    // `/inference/go` is a PREFIX of `/inference/google`. A substring check
    // therefore files a Zen google request under the Go account, and the key
    // captured from it is then used for Go requests — the wrong credential,
    // which is worse than no credential: it fails somewhere else.
    expect(
      isGoPlaneUrl("https://opencode.ai/inference/google/v1beta/models")
    ).toBe(false);
    expect(isGoPlaneUrl("https://opencode.ai/inference/google/v1beta")).toBe(
      false
    );
    expect(
      gatewayPlaneFor("https://opencode.ai/inference/google/v1beta/models")
    ).toBe("opencode");
    expect(isGoPlaneUrl("https://opencode.ai/inference/openai/v1/chat")).toBe(
      false
    );
  });

  it("answers for a bare path as well as for a URL", () => {
    // A caller with no origin passes the path, and the plane is a property of
    // the path.
    expect(isGoPlaneUrl("/zen/go/v1/models")).toBe(true);
    expect(isGoPlaneUrl("/inference/go/openai/v1/models")).toBe(true);
    expect(isGoPlaneUrl("/inference/openai/v1/models")).toBe(false);
    // And a string that is neither a URL nor a path is not guessed at.
    expect(isGoPlaneUrl("not a url")).toBe(false);
  });
});

describe("request-shape · gatewayPlaneFor", () => {
  it("attributes each endpoint family to its plane", () => {
    // Both families, because a credential's format decides which one a request
    // belongs on and the plane is the same either way.
    expect(
      gatewayPlaneFor("https://opencode.ai/zen/go/v1/chat/completions")
    ).toBe("opencode-go");
    expect(gatewayPlaneFor("https://opencode.ai/zen/v1/chat/completions")).toBe(
      "opencode"
    );
    expect(
      gatewayPlaneFor("https://opencode.ai/inference/go/openai/v1/responses")
    ).toBe("opencode-go");
    expect(
      gatewayPlaneFor("https://opencode.ai/inference/openai/v1/responses")
    ).toBe("opencode");
  });

  it("answers nothing for a URL that is not a gateway URL", () => {
    // A rotation is a side effect, so an unrecognised URL must not guess a
    // plane — and an unparseable one must not throw.
    expect(gatewayPlaneFor("https://example.com/v1/chat")).toBe("");
    expect(gatewayPlaneFor("https://opencode.ai")).toBe("");
    expect(gatewayPlaneFor("not a url")).toBe("");
  });
});

describe("request-shape · authHeaderFor", () => {
  it("reads the header each protocol actually uses", () => {
    expect(authHeaderFor("https://opencode.ai/zen/v1/messages")).toBe(
      "x-api-key"
    );
    expect(
      authHeaderFor(
        "https://opencode.ai/zen/v1/models/gemini-3:streamGenerateContent?alt=sse"
      )
    ).toBe("x-goog-api-key");
    expect(
      authHeaderFor(
        "https://opencode.ai/zen/v1/models/gemini-3:generateContent"
      )
    ).toBe("x-goog-api-key");
  });

  it("defaults to authorization, and survives an unparseable URL", () => {
    expect(authHeaderFor("https://opencode.ai/zen/v1/responses")).toBe(
      "authorization"
    );
    expect(authHeaderFor("https://opencode.ai/zen/v1/chat/completions")).toBe(
      "authorization"
    );
    expect(authHeaderFor("::::")).toBe("authorization");
  });
});

describe("request-shape · requestUrlOf", () => {
  it("reads every form fetch accepts", () => {
    expect(requestUrlOf("https://a.example/x")).toBe("https://a.example/x");
    expect(requestUrlOf(new URL("https://b.example/y"))).toBe(
      "https://b.example/y"
    );
    expect(requestUrlOf(new Request("https://c.example/z"))).toBe(
      "https://c.example/z"
    );
  });

  it("answers an empty string when there is no URL to read", () => {
    expect(requestUrlOf({} as unknown as RequestInfo)).toBe("");
    expect(requestUrlOf({ url: 42 } as unknown as RequestInfo)).toBe("");
    expect(
      requestUrlOf({
        url: new URL("https://d.example/w"),
      } as unknown as RequestInfo)
    ).toBe("https://d.example/w");
  });
});

describe("request-shape · headerSourceOf", () => {
  it("prefers init.headers over the Request's own", () => {
    const request = new Request("https://a.example", {
      headers: { "x-from": "request" },
    });
    const fromInit = headerSourceOf(request, {
      headers: { "x-from": "init" },
    });
    expect(new Headers(fromInit).get("x-from")).toBe("init");
  });

  it("falls back to the Request, then to nothing", () => {
    const request = new Request("https://a.example", {
      headers: { "x-from": "request" },
    });
    expect(new Headers(headerSourceOf(request)).get("x-from")).toBe("request");
    expect(headerSourceOf("https://a.example")).toBeUndefined();
  });
});

describe("request-shape · modelIdOf", () => {
  it("reads the id under `model`, on either JSON route", () => {
    expect(modelIdOf(JSON.stringify({ model: "gpt-5.4" }))).toBe("gpt-5.4");
  });

  it("answers undefined for every shape that names no model", () => {
    for (const body of [
      undefined,
      null,
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ model: "" }),
      JSON.stringify({ model: 42 }),
      JSON.stringify([1, 2]),
      JSON.stringify("a string"),
      Buffer.from(JSON.stringify({ model: "x" })),
    ]) {
      expect(modelIdOf(body as never), String(body)).toBeUndefined();
    }
  });
});

describe("request-shape · toolNamesOf", () => {
  it("reads both wire shapes, comma-joined", () => {
    expect(
      toolNamesOf(
        JSON.stringify({ tools: [{ name: "read" }, { name: "bash" }] })
      )
    ).toBe("read,bash");
    expect(
      toolNamesOf(
        JSON.stringify({
          tools: [
            { function: { name: "read" }, type: "function" },
            { function: { name: "bash" }, type: "function" },
          ],
        })
      )
    ).toBe("read,bash");
  });

  it("answers an empty string for every malformed body", () => {
    for (const body of [
      undefined,
      null,
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ tools: "nope" }),
      JSON.stringify({ tools: [null, 1, "x", {}, { function: {} }] }),
    ]) {
      expect(toolNamesOf(body as never), String(body)).toBe("");
    }
  });
});

describe("request-shape · constants", () => {
  it("sends the Anthropic version the client sends", () => {
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });
});
