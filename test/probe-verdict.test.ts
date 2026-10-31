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
});

describe("the busy gateway", () => {
  it("is its own shape, and not a closure of the tier", () => {
    // A loaded gateway is not a dead tier: it says nothing about the route or
    // the account, so it must not be reported as either.
    expect(gatewayBusy({ status: 429, summary: "" })).toBe(true);
    expect(gatewayBusy({ status: 403, summary: "FreeTierError" })).toBe(false);
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
