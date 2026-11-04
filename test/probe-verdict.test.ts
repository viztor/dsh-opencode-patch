/**
 * The rules that decide whether a live case SKIPS or FAILS.
 *
 * These used to live inside `test/e2e/protocol-routing.e2e.ts`, where only a run
 * with a key against the live gateway could exercise them — so a mistake in them
 * showed up as a red or a silently-skipped case, at the vendor's schedule.
 *
 * They are the rules that decide what a red run MEANS, which makes them worth
 * more than the routing cases they gate: two of the last four rotations turned a
 * live case red for a vendor-side reason, and each time the fix was here.
 *
 * @module test/probe-verdict.test
 */

import { describe, expect, it } from "vitest";

import {
  accessDisabled,
  freeTierClosed,
  freeUsageCapped,
  freeWalkGap,
  gatewayBusy,
  retiredAtTheGateway,
  usableAsSubject,
} from "./e2e/verdict.ts";

describe("the free tier's refusal", () => {
  it("is read from the body, whatever status carries it", () => {
    // Measured: `403 FreeTierError` on both endpoint families, with and without
    // an org id — and the same body can arrive under another status when the
    // gateway changes its mind about the code. The body is the stable part.
    expect(
      freeTierClosed({ status: 403, summary: '{"type":"FreeTierError"}' })
    ).toBe(true);
    expect(
      freeTierClosed({ status: 500, summary: '{"type":"FreeTierError"}' })
    ).toBe(true);
    // A 403 that is NOT the free tier is a different fact, and the cases treat
    // it differently: one is a gate this repository cannot open, the other is an
    // account that cannot spend.
    expect(
      freeTierClosed({ status: 403, summary: '{"type":"AuthError"}' })
    ).toBe(false);
  });

  it("includes the tier's usage cap, which is the same gate and not a busy gateway (L3)", () => {
    const capped = {
      status: 429,
      summary: '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
    };
    expect(freeTierClosed(capped)).toBe(true);
    expect(gatewayBusy(capped)).toBe(false);
  });
});

describe("an account-level refusal", () => {
  it("covers each shape the gateway uses, and only those", () => {
    expect(accessDisabled({ status: 402, summary: "" })).toBe(true);
    expect(
      accessDisabled({ status: 500, summary: "Insufficient account funds" })
    ).toBe(true);
    expect(
      accessDisabled({ status: 403, summary: "Model access is disabled" })
    ).toBe(true);
    expect(accessDisabled({ status: 429, summary: "" })).toBe(true);
    expect(accessDisabled({ status: 0, summary: "" })).toBe(true);
  });

  it("does not read a 403 for another reason as an entitlement refusal", () => {
    // The conjunction matters: a bare `403` is not "the account cannot spend",
    // and treating every 403 as one would turn a routing regression into a skip.
    expect(accessDisabled({ status: 403, summary: "Forbidden" })).toBe(false);
    expect(accessDisabled({ status: 401, summary: "Unauthorized" })).toBe(
      false
    );
    expect(accessDisabled({ status: 404, summary: "no route" })).toBe(false);
  });
});

describe("a retirement", () => {
  it("is a 410, or the vendor's word for it under another status", () => {
    expect(retiredAtTheGateway({ status: 410, summary: "" })).toBe(true);
    expect(
      retiredAtTheGateway({
        status: 200,
        summary: '{"type":"ModelDeprecated"}',
      })
    ).toBe(true);
    // The registry can still list a retired model as active — that is exactly
    // the case this rule exists for (`gemini-3-flash` was listed and refused).
    expect(retiredAtTheGateway({ status: 200, summary: "ok" })).toBe(false);
  });

  it("is an upstream's withdrawal too, but only when a 400 says so", () => {
    // Measured on a free model the catalog still listed: the gateway relays the
    // upstream's answer under a 400, the same status a malformed request gets.
    const withdrawn = {
      status: 400,
      summary: "Upstream request failed: Model is unavailable",
    };
    expect(retiredAtTheGateway(withdrawn)).toBe(true);
    expect(usableAsSubject(withdrawn)).toBe(false);
    // A 400 for any other reason is the request's fault, and a case about the
    // route has to see it rather than walk past it.
    const malformed = { status: 400, summary: "Invalid request body" };
    expect(retiredAtTheGateway(malformed)).toBe(false);
    expect(usableAsSubject(malformed)).toBe(true);
    // The words under another status are not this shape.
    expect(
      retiredAtTheGateway({ status: 500, summary: "Model is unavailable" })
    ).toBe(false);
  });
});

describe("the busy gateway", () => {
  it("is its own shape, and not a closure of the tier", () => {
    // A loaded gateway is not a dead tier: it says nothing about the route or
    // the account, so it must not be reported as either.
    expect(gatewayBusy({ status: 429, summary: "" })).toBe(true);
    expect(gatewayBusy({ status: 403, summary: "FreeTierError" })).toBe(false);
  });
});

describe("why a walk of free candidates found no completion", () => {
  const capped = {
    status: 429,
    summary: '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
  };
  const gated = { status: 403, summary: '{"type":"FreeTierError"}' };
  const busy = { status: 429, summary: "" };
  const retired = { status: 410, summary: "" };

  it("names the usage cap, never the session gate, when the cap answered", () => {
    // A run whose every candidate met the cap measured the account it spends
    // from: reporting that as "the tier needs a session token" names a cause
    // that was not observed.
    expect(freeUsageCapped(capped)).toBe(true);
    expect(freeUsageCapped(gated)).toBe(false);
    expect(freeWalkGap([capped, capped])).toBe("capped");
    expect(freeWalkGap([gated, capped, retired])).toBe("capped");
  });

  it("is a busy gateway first, whatever else answered", () => {
    expect(freeWalkGap([capped, busy])).toBe("busy");
    expect(freeWalkGap([gated, busy, retired])).toBe("busy");
  });

  it("is a closed tier when each was gated, withdrawn or never answered", () => {
    expect(freeWalkGap([gated, retired, { status: 0, summary: "" }])).toBe(
      "closed"
    );
    expect(freeWalkGap([])).toBe("closed");
  });
});

describe("a candidate is a subject when the answer was about the ROUTE", () => {
  it("accepts a completion, and a refusal the case can explain", () => {
    expect(usableAsSubject({ status: 200, summary: "ok" })).toBe(true);
    // A 403 the case turns into a skip is still an answer about the route: the
    // endpoint exists, the account cannot use it. `accessDisabled` is what the
    // case consults next.
    expect(usableAsSubject({ status: 403, summary: "Forbidden" })).toBe(true);
  });

  it("walks past silence, a refusal, and a retirement", () => {
    expect(usableAsSubject({ status: 0, summary: "" })).toBe(false);
    expect(usableAsSubject({ status: 429, summary: "" })).toBe(false);
    expect(usableAsSubject({ status: 402, summary: "" })).toBe(false);
    expect(usableAsSubject({ status: 410, summary: "" })).toBe(false);
    expect(usableAsSubject({ status: 200, summary: "ModelDeprecated" })).toBe(
      false
    );
  });
});
