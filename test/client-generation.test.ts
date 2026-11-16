/**
 * The client-generation table (`src/utils/client-generation.ts`, L6): the
 * emulated row's header names are what `planeHeadersFor` writes, and every
 * row records well-formed data.
 *
 * `test/request-shape.test.ts` pins `planeHeadersFor`'s exact output and the
 * User-Agent's literal form; this file rebuilds that output from the emulated
 * row, so the writer keeps reading the row in its assembly order. The other
 * cases are RECORD checks: `sessionValue` and the whole 2.x row are data
 * nothing in `src` reads yet, and the titles say so.
 *
 * @module test/client-generation.test
 */
import { describe, expect, it } from "vitest";

import {
  CLIENT_GENERATIONS,
  EMULATED_GENERATION,
  planeHeadersFor,
} from "./support/src.ts";

const SES = "ses_0123456789abAAAAAAAAAAAAAA";
const PARENT = "ses_0123456789abBBBBBBBBBBBBBB";
const MSG = "msg_0123456789abCCCCCCCCCCCCCC";

describe("client generations · the emulated row is what the plugin sends", () => {
  const row = CLIENT_GENERATIONS[EMULATED_GENERATION];

  it("records 1.x as the emulated generation, its session headers carrying the session's own id", () => {
    expect(EMULATED_GENERATION).toBe("1.x");
    // Recorded, not read: planeHeadersFor writes the session id into every
    // session header whatever this field says.
    expect(row.sessionValue).toBe("session");
  });

  it("rebuilds planeHeadersFor's plane and relay output from the row", () => {
    const pairs = (names: readonly string[], value: string) =>
      names.map((name) => [name, value]);
    expect(planeHeadersFor({ relay: false, session: SES })).toEqual(
      pairs(row.planeSessionHeaders, SES)
    );
    expect(planeHeadersFor({ relay: true, session: SES })).toEqual([
      ...pairs(row.planeSessionHeaders, SES),
      ...pairs(row.relaySessionHeaders, SES),
    ]);
    expect(
      planeHeadersFor({
        origin: { client: "cli", project: "p", request: MSG },
        parent: PARENT,
        relay: false,
        session: SES,
      })
    ).toEqual([
      ...pairs(row.planeSessionHeaders, SES),
      ...pairs(row.parentHeaders, PARENT),
      [row.originHeaders.client, "cli"],
      [row.originHeaders.request, MSG],
      [row.originHeaders.project, "p"],
    ]);
  });
});

describe("client generations · the recorded 2.x row", () => {
  const row = CLIENT_GENERATIONS["2.x"];

  it("records its User-Agent format as opencode/<channel>/<version>/<client>", () => {
    // Assembled, never written out: a concrete 2.x literal in the tree is a
    // claim `cli:version` refuses.
    const [channel, version, client] = ["dev", "0.0.0-dev-1", "cli"];
    expect(row.userAgent({ channel, client, version })).toBe(
      ["opencode", channel, version, client].join("/")
    );
    // A part it was not given stays a placeholder rather than a value.
    expect(row.userAgent({ version })).toBe(
      ["opencode", "<channel>", version, "<client>"].join("/")
    );
  });

  it("records all four session headers on a plane, carrying the affinity id, and no message id", () => {
    expect(row.sessionValue).toBe("affinity");
    expect(row.relaySessionHeaders).toEqual([]);
    expect(new Set(row.planeSessionHeaders)).toEqual(
      new Set([
        ...CLIENT_GENERATIONS["1.x"].planeSessionHeaders,
        ...CLIENT_GENERATIONS["1.x"].relaySessionHeaders,
      ])
    );
    expect(Object.hasOwn(row.originHeaders, "request")).toBe(false);
    expect(row.evidence).toMatch(/^recorded, not measured/u);
  });
});

describe("client generations · every row is well-formed", () => {
  it("records each header name in lower case, once per list", () => {
    for (const [id, row] of Object.entries(CLIENT_GENERATIONS)) {
      const lists: readonly (readonly string[])[] = [
        row.planeSessionHeaders,
        row.relaySessionHeaders,
        row.parentHeaders,
        Object.values(row.originHeaders),
      ];
      for (const list of lists) {
        expect(new Set(list).size, id).toBe(list.length);
        for (const name of list) {
          expect(name, id).toBe(name.toLowerCase());
          expect(name.length, id).toBeGreaterThan(0);
        }
      }
      // A session header is never also a relay one in the same generation.
      expect(
        row.planeSessionHeaders.filter((name) =>
          (row.relaySessionHeaders as readonly string[]).includes(name)
        ),
        id
      ).toEqual([]);
      expect(row.evidence.length, id).toBeGreaterThan(0);
    }
  });
});
