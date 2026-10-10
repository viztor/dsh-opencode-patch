import { supportedProtocols } from "@deepseek-ai/dsh-llm-pi-ai";
import { describe, expect, it } from "vitest";

import { PROTOCOL_FOR_SDK, ROUTE_FOR_PLANE_PROTOCOL } from "../src/index.ts";

/**
 * The protocols this plugin mounts must be ones the harness's own pi-ai layer
 * can build.
 *
 * `dsh-llm-pi-ai` constructs a hand-declared route from `PROTOCOLS`, and that
 * table has three entries. A route naming anything else is refused outright, so
 * the plugin's whole routing layer is bounded by this list - and nothing checked
 * it: the unit suite mounts against a stand-in that accepts any `api`, and the
 * e2e suite talks to the gateway without going through the mount at all.
 *
 * That is how `mistral-conversations` shipped. It is in `COMPAT_GATES`, which
 * looks like a protocol registry and is not one, and the real table refuses it.
 *
 * `it.fails` while that route is still declared: it passes only while the gap is
 * real, and turns red the moment the mapping is corrected, which is the signal
 * to make it a plain assertion.
 */
describe("mount · the protocols the harness can build", () => {
  it("names only protocols dsh-llm-pi-ai supports", () => {
    const supported = new Set(supportedProtocols());
    const named = [
      ...new Set([
        ...Object.values(PROTOCOL_FOR_SDK),
        ...Object.values(ROUTE_FOR_PLANE_PROTOCOL).flatMap((plane) =>
          Object.keys(plane.routes)
        ),
      ]),
    ];
    expect(named.filter((protocol) => !supported.has(protocol))).toEqual([]);
  });
});
