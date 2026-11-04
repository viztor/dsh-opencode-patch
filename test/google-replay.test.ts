import { describe, expect, it } from "vitest";

import {
  googleHistoryFor,
  googleReplayFor,
  googleReplayStream,
} from "./support/src.ts";

describe("Google replay route boundary", () => {
  it("leaves error chunks JSON-serializable and does not invent missing replay", async () => {
    const failed = {
      type: "finish",
      reason: { kind: "error", failure: { code: "AUTH", message: "test" } },
    };
    async function* stream() {
      yield failed;
    }
    const output = [];
    for await (const chunk of googleReplayStream(
      stream(),
      "internal",
      "public"
    ))
      output.push(chunk);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- exercise the host's JSON transport, not cloning
    expect(output).toEqual(JSON.parse(JSON.stringify(output)));
    expect(output[0]).toBe(failed);
  });
  it("does not rewrite foreign or incomplete replay envelopes", () => {
    for (const state of [
      undefined,
      {},
      { response: {} },
      { response: { kind: "other" } },
      {
        response: {
          kind: "pi-ai",
          api: "anthropic-messages",
          provider: "public",
        },
      },
      {
        response: {
          kind: "pi-ai",
          api: "google-generative-ai",
          provider: "another-provider",
        },
      },
    ]) {
      expect(googleReplayFor(state, "public", "internal")).toBe(state);
    }
    const messages = [
      {},
      { role: "user", content: [] },
      { role: "assistant", source: { provider: "foreign" } },
      { role: "assistant", source: { provider: "public" } },
    ];
    expect(googleHistoryFor(messages, "public", "internal")).toEqual(messages);
    expect(googleHistoryFor(undefined, "public", "internal")).toBeUndefined();
  });
});
