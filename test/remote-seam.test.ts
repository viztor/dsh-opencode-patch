/**
 * Each remote's answer, carried to its client caller whole.
 *
 * The host services and the card's callers are tested apart, each against
 * shapes its own file builds; this file joins them. A real service answers,
 * the answer crosses the seam as the gateway's `{ ok, value | error }`
 * envelope (through a JSON round trip, or a structured clone, as the wire
 * would carry it), and the caller's outcome is asserted against the service's
 * own answer. So a client-side parser that drops a field the service sends
 * (the usage reading's `allowance`, its plane spend, the overflow floor's
 * `quotaUnavailable`) fails here, whichever side moved.
 *
 * The store and usage cases were written on the base of P9 (the remote seam),
 * before the seam was rebuilt, and green there. The two purge cases were
 * rewritten afterwards to run the real `ModelPurgeService`, and the whole file
 * was then run green on the base, with a control that fails there
 * (docs/improvement-plan.md, P9). The file is the pin the refactor is held to.
 *
 * @module test/remote-seam.test
 */
import { Context } from "@deepseek-ai/cordis";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpencodeStore,
  type FixtureStore,
} from "./support/opencode-store-fixture.ts";
import {
  clearSessionUsageStore,
  findModelSpecOn,
  GO_MODEL_LIMITS,
  inspectStore,
  OpencodeStoreService,
  ModelPurgeService,
  parseFailure,
  parseModelsDevCatalog,
  purgeDeprecatedModels,
  readGoUsage,
  recordTurnUsage,
} from "./support/src.ts";
import {
  okBody,
  serviceWithKey,
  serviceWithoutKey,
  stubFetch,
} from "./support/usage-fixture.ts";

const stores: FixtureStore[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearSessionUsageStore();
  for (const store of stores.splice(0)) {
    store.cleanup();
  }
});

/** The database path inside a fixture's data root. */
const databaseOf = (store: FixtureStore): string =>
  `${store.root}/opencode/opencode.db`;

/**
 * What the wire does to a value: a JSON round trip, which (unlike a
 * structured clone) drops an `undefined`-valued key, as the gateway's
 * transport does.
 */
const overTheWire = <Value>(value: Value): Value =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip IS the wire being modelled
  JSON.parse(JSON.stringify(value)) as Value;

/**
 * A Go model the generated limits table prices, picked by shape so a refresh
 * of the table cannot fail a case: the one an attached allowance names.
 */
const pricedGoModel = (): string => {
  for (const [id, row] of Object.entries(GO_MODEL_LIMITS)) {
    if (Number.isFinite(row.go) && findModelSpecOn("go", id) !== undefined) {
      return id;
    }
  }
  throw new Error("no priced limits row the Go catalog lists");
};

describe("remote seam · store: the service's inspection reaches the card whole", () => {
  it("carries an account with every summary field", async () => {
    const expires = Date.now() + 86_400_000;
    const store = createOpencodeStore(
      [
        {
          integrationId: "opencode",
          label: "Default",
          value: JSON.stringify({
            access: "st_fixture_access",
            expires,
            metadata: { email: "someone@example.com", orgName: "Fixture Org" },
            refresh: "rt_fixture_refresh",
            type: "oauth",
          }),
        },
      ],
      {
        accessToken: "st_fixture_access",
        email: "someone@example.com",
        refreshToken: "rt_fixture_refresh",
        tokenExpiry: expires,
      }
    );
    stores.push(store);
    const service = new OpencodeStoreService(new Context(), {
      resolveStorePath: () => databaseOf(store),
    });
    const answer = await service.inspect();
    // Non-vacuous: the fixture fills every field the summary can carry.
    expect(answer.account).toMatchObject({
      accountId: expect.any(String),
      email: "someone@example.com",
      expired: false,
      expiresAt: expect.any(String),
      label: "Default",
      orgName: "Fixture Org",
      refreshable: true,
      type: "oauth",
    });
    await expect(
      inspectStore({
        remote: {
          opencodeStore: {
            inspect: async () => ({ ok: true, value: structuredClone(answer) }),
          },
        },
      })
    ).resolves.toEqual({ inspection: answer, kind: "inspected" });
  });

  it("carries a missing installation with its message and shown path", async () => {
    const store = createOpencodeStore([]);
    stores.push(store);
    const service = new OpencodeStoreService(new Context(), {
      resolveStorePath: () => `${store.root}/absent/opencode.db`,
    });
    const answer = await service.inspect();
    expect(answer).toMatchObject({ found: false, message: "not_found" });
    await expect(
      inspectStore({
        remote: {
          opencodeStore: {
            inspect: async () => ({ ok: true, value: structuredClone(answer) }),
          },
        },
      })
    ).resolves.toEqual({ inspection: answer, kind: "inspected" });
  });
});

describe("remote seam · usage: the service's reading reaches the settings summary whole", () => {
  /** A scope whose `opencodeGoUsage.read` answers with `answer`. */
  const scopeWith = (answer: () => Promise<unknown>): unknown => ({
    remote: { opencodeGoUsage: { read: answer } },
  });

  it("keeps the allowance and the session's plane spend", async () => {
    const model = pricedGoModel();
    recordTurnUsage(
      "s-seam",
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      { input: 1, output: 2 },
      model,
      false,
      "go"
    );
    stubFetch(() => new Response(okBody()));
    const answer = await serviceWithKey("sk-live-key").read({
      model,
      provider: "opencode-go",
      sessionId: "s-seam",
    });
    // Non-vacuous: the fields a vendor-payload whitelist would drop are here.
    expect(answer.allowance).toBeDefined();
    expect(answer.session?.planeCostFormatted).toBeDefined();
    expect(answer.session?.planeSpendUsd).toBeDefined();
    await expect(
      readGoUsage(
        scopeWith(async () => ({ ok: true, value: overTheWire(answer) }))
      )
    ).resolves.toEqual(answer);
  });

  it("keeps the overflow floor's quotaUnavailable flag", async () => {
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    stubFetch(
      () =>
        new Response(
          '{"error":{"code":"EntitlementError","message":"no Go subscription"}}',
          { status: 403 }
        )
    );
    const answer = await serviceWithKey("sk-live-key").read();
    expect(answer.quotaUnavailable).toBe(true);
    expect(answer.zenOverflow).toBe(true);
    await expect(
      readGoUsage(
        scopeWith(async () => ({ ok: true, value: overTheWire(answer) }))
      )
    ).resolves.toEqual(answer);
  });

  it("rejects with the service's own RemoteError, which the pill reads as unconfigured", async () => {
    const error: unknown = await serviceWithoutKey()
      .read()
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteError);
    await expect(
      readGoUsage(scopeWith(async () => ({ error, ok: false })))
    ).rejects.toBe(error);
    expect(parseFailure(error)).toEqual({
      configured: false,
      message: "OpenCode Go API key is not configured",
      reason: undefined,
      retainPrevious: false,
      source: undefined,
    });
  });
});

describe("remote seam · purge: a result and the host's refusal reach the card as the same outcome", () => {
  const scopeWith = (purge: () => Promise<unknown>): unknown => ({
    remote: { opencodeModelPurge: { purge } },
  });

  /** One retired id, referenced at every site the purge strips. */
  const registry = {
    opencode: {
      models: {
        "live-free": { limit: { context: 1000 }, name: "Live" },
        "retired-free": { status: "deprecated" },
      },
    },
  };

  /** A config editor that applies each change to the entry it was handed. */
  const editorOver = (
    entries: readonly { options: { config: unknown } }[]
  ) => ({
    edit: async (
      entry: unknown,
      change: (current: Record<string, unknown>) => Record<string, unknown>
    ) => {
      const holder = entry as { options: { config: Record<string, unknown> } };
      holder.options.config = change(holder.options.config);
    },
    entries: () => entries,
  });

  it("carries the service's result, with every site it reports", async () => {
    parseModelsDevCatalog(registry);
    vi.stubGlobal("fetch", async () => ({
      json: async () => registry,
      ok: true,
    }));
    const ctx = new Context();
    ctx.provide(
      "configEditor" as never,
      editorOver([
        {
          options: {
            config: {
              providers: {
                opencode: {
                  models: [{ id: "retired-free" }, { id: "live-free" }],
                },
              },
            },
          },
        },
        {
          options: {
            config: {
              allowedModels: [{ model: "retired-free", provider: "opencode" }],
            },
          },
        },
        {
          options: {
            config: {
              summarizationModel: "retired-free",
              summarizationProvider: "opencode",
            },
          },
        },
      ]) as never
    );
    const result = await new ModelPurgeService(ctx).purge();
    // The fixture reaches every site, so the case is not vacuous.
    expect(result.removed.map((row) => row.site)).toEqual([
      undefined,
      "subagent",
      "summarizer",
    ]);
    await expect(
      purgeDeprecatedModels(
        scopeWith(async () => ({ ok: true, value: overTheWire(result) }))
      )
    ).resolves.toEqual({ kind: "purged", result: overTheWire(result) });
  });

  it("carries the service's own refusal in its own words", async () => {
    const error: unknown = await new ModelPurgeService(new Context())
      .purge()
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteError);
    await expect(
      purgeDeprecatedModels(scopeWith(async () => ({ error, ok: false })))
    ).resolves.toEqual({
      kind: "failed",
      message: (error as Error).message,
    });
  });
});
