/**
 * `GoUsageService` — the reading it hands back.
 *
 * @module test/usage-service-readings.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { freeZenModel } from "./support/catalogs.ts";
import {
  clearCapturedApiKeys,
  clearSessionUsageStore,
  findModelSpecOn,
  GO_MODEL_LIMITS,
  getSessionUsage,
  recordTurnUsage,
} from "./support/src.ts";
import {
  failureOf,
  GO_USAGE_URL,
  okBody,
  serviceWithKey,
  serviceWithoutKey,
  stubFetch,
} from "./support/usage-fixture.ts";

/**
 * A priced row of the generated limits table whose id the Go catalog names
 * under a different display name, picked by shape so a refresh of either
 * cannot fail a case: the name is what an attached allowance carries.
 */
const namedAllowanceRow = (): {
  id: string;
  name: string;
  row: (typeof GO_MODEL_LIMITS)[string];
} => {
  for (const [id, row] of Object.entries(GO_MODEL_LIMITS)) {
    const name = findModelSpecOn("go", id)?.name;
    if (Number.isFinite(row.go) && name !== undefined && name !== id) {
      return { id, name, row };
    }
  }
  throw new Error("no priced limits row the Go catalog names differently");
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  clearCapturedApiKeys();
  clearSessionUsageStore();
});

describe("GoUsageService readings", () => {
  it("answers the zeroed Zen-overflow reading when only Zen is configured", async () => {
    // Go has no quota to report without a Go credential, so every window sits
    // at zero and the meter hands over to the Zen balance. The account id is
    // fresh per read here: there is no Go credential to key an identity on.
    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    const service = serviceWithoutKey();

    const first = await service.read();
    const second = await service.read();
    expect(first.zenOverflow).toBe(true);
    expect(first.rolling.percent).toBe(0);
    expect(first.weekly.percent).toBe(0);
    expect(first.monthly.percent).toBe(0);
    expect(first.monthly.status).toBe("ok");
    // One reset instant for all three windows: a zeroed reading still has to
    // say when it resets, and the meter renders one countdown.
    expect(first.weekly.resetsAt).toBe(first.monthly.resetsAt);
    expect(first.source).toBeDefined();
    expect(second.source).not.toBe(first.source);
  });

  it("treats an explicit Zen route as overflow even with no Zen credit", async () => {
    // The client naming the Zen route is itself the signal that Go has nothing
    // to say, so the meter gets the zeroed reading instead of an error.
    const usage = await serviceWithoutKey().read({ provider: "opencode" });
    expect(usage.zenOverflow).toBe(true);
    expect(usage.rolling.percent).toBe(0);
    expect(usage.weekly.percent).toBe(0);
  });

  it("refuses to invent a reading when neither plane is configured", async () => {
    // An unconfigured account is the one case with no reading to show, so the
    // client is told so outright rather than handed a zeroed meter.
    const service = serviceWithKey("");
    const failure = await failureOf(service.read());
    expect(failure.message).toBe("OpenCode Go API key is not configured");
    expect(failure.details).toEqual({
      configured: false,
      retainPrevious: false,
      retryable: false,
    });
  });

  it("attaches the spend of the conversation that asked for it", async () => {
    // Spend is per conversation: two open sessions must not read the same total.
    recordTurnUsage(
      "session-a",
      { inputTokens: 1_000_000, totalTokens: 1_000_000 },
      { input: 1, output: 1 },
      "model-a"
    );
    recordTurnUsage(
      "session-b",
      { inputTokens: 2_000_000, totalTokens: 2_000_000 },
      { input: 1, output: 1 },
      "model-b"
    );
    stubFetch(() => new Response(okBody()));

    const a = await serviceWithKey("sk-live-key").read({
      sessionId: "session-a",
    });
    const b = await serviceWithKey("sk-live-key").read({
      sessionId: "session-b",
    });
    expect(a.session?.totalTokens).toBe(1_000_000);
    expect(a.session?.activeModel).toBe("model-a");
    expect(b.session?.totalTokens).toBe(2_000_000);
    expect(b.session?.activeModel).toBe("model-b");
  });

  it("falls back to the most recent conversation when the query names none", async () => {
    // A caller that knows no session still gets spend rather than an empty
    // figure — the Host can only offer the latest, so that is what it is.
    recordTurnUsage(
      "session-a",
      { inputTokens: 10, totalTokens: 10 },
      { input: 1, output: 1 },
      "model-a"
    );
    recordTurnUsage(
      "session-b",
      { inputTokens: 20, totalTokens: 20 },
      { input: 1, output: 1 },
      "model-b"
    );
    stubFetch(() => new Response(okBody()));

    const usage = await serviceWithKey("sk-live-key").read();
    expect(usage.session?.activeModel).toBe("model-b");
    expect(usage.session?.totalTokens).toBe(20);
  });

  it("omits session spend entirely when nothing has been recorded", async () => {
    // A meter that rendered "$0.00" against an empty store would be reporting a
    // lie; the key is simply absent.
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      sessionId: "none",
    });
    expect(Object.hasOwn(usage, "session")).toBe(false);
    expect(usage.monthly.percent).toBe(100);
  });

  it("names the PICKED model even when the catalog has no price for it", async () => {
    // The bug this pins: the panel named the PREVIOUS model while the picker
    // showed the new one, because the re-description was gated on a catalog hit.
    // A missing price is its own answer; it is never a reason to display the
    // wrong model. `space-bunny-x` stands in for that case — a picked id the catalog
    // has no row for. (models.dev briefly ADDED `space-bunny`, proving the
    // premise is time-sensitive: assert against an id that cannot appear.)
    recordTurnUsage(
      "s-miss",
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      { input: 0.15, output: 0.5 },
      "mimo-v2.6-flash-free",
      true
    );
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      model: "space-bunny-x",
      provider: "opencode-go",
      sessionId: "s-miss",
    });
    expect(usage.session?.activeModel).toBe("space-bunny-x");
    // No name and no price, but NOT the old model and NOT a leftover `freeModel`
    // from the free model the session actually last ran.
    expect(usage.session?.activeModelName).toBeUndefined();
    expect(usage.session?.freeModel).toBeUndefined();
    // The spend total is history and must survive the swap.
    expect(usage.session?.turns).toBe(1);
  });

  it("fills in the catalog's display name for the model a turn recorded", async () => {
    // A turn records the id — that is what the gateway speaks — so without this
    // the meter's row showed the id where a user expects the catalog name for
    // it. The model and its name are read off the Zen shim (the plane a reading
    // with no route names), never pinned, so a refresh cannot retire them.
    const model = freeZenModel();
    const name = findModelSpecOn("zen", model)?.name;
    expect(name, `${model} has no catalog name`).toBeTruthy();
    recordTurnUsage(
      "s-name",
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      { input: 0, output: 0 },
      model,
      true
    );
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      sessionId: "s-name",
    });
    expect(usage.session?.activeModel).toBe(model);
    expect(usage.session?.activeModelName).toBe(name);
    expect(usage.session?.freeModel).toBe(true);
  });

  it("leaves the name absent for a model the catalog does not carry", async () => {
    recordTurnUsage(
      "s-unknown",
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      { input: 1, output: 2 },
      "some-model-nobody-lists",
      false
    );
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      sessionId: "s-unknown",
    });
    expect(usage.session?.activeModelName).toBeUndefined();
  });

  it("attaches the selected model's monthly allowance, both tiers, and only for a listed model", async () => {
    // The one thing the live payload cannot supply: what the percentages are a
    // percentage OF. Resolved on the Host from the generated table, and carrying
    // both tiers because the plan is not discoverable — guessing one would
    // misstate the money by 2-3x.
    stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");

    // The row is read off the generated table, never pinned, so a refresh of
    // the vendor's page cannot fail this case; only the attachment is asserted.
    const { id, name, row } = namedAllowanceRow();
    const listed = await service.read({ model: id });
    expect(listed.allowance).toEqual({
      go: row.go,
      goPlus: row.goPlus,
      // **The catalog's spelling of the model, not the id the picker sent.**
      // The row pairs this figure with a model name, and the client cannot
      // resolve one — it ships neither the catalog nor the table. So the Host
      // names the model the allowance BELONGS TO, which is the picked one: the
      // session's own model is a different model, and labelling this figure
      // with that one states something false about the money.
      model: name,
    });

    // A model the plan does not publish an allowance for gets nothing at all,
    // rather than a zero that would read as "you get nothing".
    const unlistedId = "unlisted-model-x";
    expect(GO_MODEL_LIMITS[unlistedId]).toBeUndefined();
    const unlisted = await service.read({ model: unlistedId });
    expect(Object.hasOwn(unlisted, "allowance")).toBe(false);

    // No selection, no figure to attribute it to.
    const unselected = await service.read();
    expect(Object.hasOwn(unselected, "allowance")).toBe(false);
  });

  it("describes a session that ran another model as the picked one, allowance and all, keeping its spend", async () => {
    // The picker names a model the last turn did not run — that is the whole
    // point of a picker — so the two are routinely different. Both rows then
    // describe the PICKED model: the allowance belongs to it, and the session
    // snapshot is re-described as it (a catalog hit here; "s-miss" above holds
    // the miss), so neither row labels a figure with a model it is not about.
    // The spend is history and survives the swap.
    const { id, name } = namedAllowanceRow();
    const EARLIER = "an-earlier-model-x";
    expect(EARLIER).not.toBe(id);
    recordTurnUsage(
      "s-picked",
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      { input: 1, output: 2 },
      EARLIER,
      false,
      "go"
    );
    const spent = getSessionUsage("s-picked")?.costUsd;
    expect(spent, "the recorded turn was priced").toBeGreaterThan(0);
    stubFetch(() => new Response(okBody()));
    const usage = await serviceWithKey("sk-live-key").read({
      model: id,
      provider: "opencode-go",
      sessionId: "s-picked",
    });
    expect(usage.allowance?.model).toBe(name);
    expect(usage.session?.activeModel).toBe(id);
    expect(usage.session?.activeModelName).toBe(name);
    expect(usage.session?.turns).toBe(1);
    expect(usage.session?.costUsd).toBe(spent);
  });

  it("marks a Go reading overflow-eligible exactly when Zen credit exists", async () => {
    // `zenOverflow` on a real reading is what tells the client the Go meters
    // may be backed by pay-as-you-go credit, so it must track Zen state and not
    // be hard-wired.
    stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");
    const withoutZen = await service.read();
    expect(withoutZen.zenOverflow).toBe(false);

    process.env.OPENCODE_API_KEY = "oc_sk_zen-key";
    const withZen = await service.read();
    expect(withZen.zenOverflow).toBe(true);
  });
});

describe("GoUsageService account-scoped read", () => {
  it("declares `readAccount` as a Remote method", async () => {
    // The sibling `dsh-opencode-go` account page calls this spelling. The marker
    // is hand-written (see `usage.ts`), and a method the gateway cannot see
    // fails exactly like one that throws, so the declaration is what is tested.
    const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
    const declared = remoteMethods(serviceWithKey("sk-live-key")).map(
      (method: { method: string }) => method.method
    );
    expect(declared).toContain("read");
    expect(declared).toContain("readAccount");
  });

  it("answers the account-scoped read with the route's reading", async () => {
    // The ref selects an account in the sibling's manager, which this plugin
    // does not enumerate; the reading it can answer is the configured route's.
    const capture = stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");

    const usage = await service.readAccount("DSH_OPENCODE_GO_ACCOUNT_AB12");

    expect(capture.url).toBe(GO_USAGE_URL);
    expect(usage.rolling.percent).toBe(15);
    expect(usage.weekly.percent).toBe(42);
  });

  it("rejects a ref that is not an identifier without reading anything", async () => {
    // A malformed ref is a bad request, not an empty account: letting it reach
    // the credential lookup would report the caller's mistake as a missing key.
    const capture = stubFetch(() => new Response(okBody()));
    const service = serviceWithKey("sk-live-key");

    for (const bad of ["", "has space", "0leading", "with-dash", "a/b"]) {
      await expect(service.readAccount(bad)).rejects.toThrow(
        "Invalid OpenCode Go account reference"
      );
    }
    expect(capture.url).toBe("");
  });
});
