/**
 * `formatUsd` (`src/utils/usd.ts`): the two dollar contracts, each a named
 * style. `test/usd-callers.test.tsx` pins what each caller shows; this file
 * holds the function's own table, moved here from the two modules that each
 * used to define one.
 *
 * @module test/usd.test
 */
import { describe, expect, it } from "vitest";

import { formatUsd } from "./support/src.ts";

describe("formatUsd · allowance", () => {
  it("writes whole dollars without cents", () => {
    expect(formatUsd(0, "allowance")).toBe("$0");
    expect(formatUsd(60, "allowance")).toBe("$60");
    expect(formatUsd(7.5, "allowance")).toBe("$7.50");
  });

  it("does not price missing or invalid allowances as zero", () => {
    for (const value of [null, undefined, Number.NaN, Infinity, -1, "60"]) {
      expect(formatUsd(value, "allowance")).toBe("—");
    }
  });
});

describe("formatUsd · metered", () => {
  it("always reads two decimals, whatever the magnitude", () => {
    // The tiered formatter (3dp below a cent, 4dp below a tenth) printed
    // $0.006 on the trigger — precision in the wrong place. A meter is a
    // gauge, not an invoice, and a number whose LENGTH changes with its value
    // makes the row shift on every turn.
    expect(formatUsd(0, "metered")).toBe("$0.00");
    expect(formatUsd(0.00012, "metered")).toBe("$0.00");
    expect(formatUsd(0.0042, "metered")).toBe("$0.00");
    expect(formatUsd(0.006, "metered")).toBe("$0.01");
    expect(formatUsd(0.42, "metered")).toBe("$0.42");
    expect(formatUsd(12.3456, "metered")).toBe("$12.35");
  });

  it("keeps the cents of a whole dollar, and says — for a value that is not a number", () => {
    expect(formatUsd(60, "metered")).toBe("$60.00");
    // A number is formatted as it is, as the metered formatter always did:
    // unifying an invalid number with the allowance's "—" would be a fix.
    expect(formatUsd(-1, "metered")).toBe("$-1.00");
    for (const value of [null, undefined, "60"]) {
      expect(formatUsd(value, "metered")).toBe("—");
    }
  });
});
