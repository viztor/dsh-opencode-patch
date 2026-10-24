/**
 * The family map's key order, which has to be ours.
 *
 * The map — one endpoint per wire family, per plane, keyed by the SDK package
 * that names it — is written verbatim into the generated shim. It used to be
 * built in whatever order the vendor's JSON happened to list its models in, and
 * that order is not stable: the catalog re-serializes on its own schedule, so
 * the same data arrives with its models in a different sequence.
 *
 * The nightly freshness job compares the committed file with a fresh generation
 * TEXTUALLY, so an unstable order means it finds a diff that contains no change
 * at all — which is how a pull request arrived whose entire content was three
 * lines of key order, and which has now happened more than once.
 *
 * @module test/catalog-family-api.test
 */

import { describe, expect, it } from "vitest";

import { parseModelsDevCatalog } from "./support/src.ts";

describe("the family map", () => {
  it("reads the same whatever order the vendor lists its models in", () => {
    const models = {
      zulu: {
        id: "zulu",
        name: "Z",
        provider: {
          api: "https://opencode.ai/inference/google/v1beta",
          npm: "@ai-sdk/google",
        },
      },
      alpha: {
        id: "alpha",
        name: "A",
        provider: {
          api: "https://opencode.ai/inference/anthropic",
          npm: "@ai-sdk/anthropic",
        },
      },
      mike: { id: "mike", name: "M" },
    };
    const provider = {
      api: "https://opencode.ai/inference/openai/v1",
      models,
    };
    const reordered = {
      opencode: {
        api: provider.api,
        models: { mike: models.mike, alpha: models.alpha, zulu: models.zulu },
      },
    };
    const first = parseModelsDevCatalog({ opencode: provider });
    const second = parseModelsDevCatalog(reordered);
    expect(second.familyApi.zen).toEqual(first.familyApi.zen);
  });

  it("sorts its keys, so the order is the parser's and not the vendor's", () => {
    // The shim's bytes must not move when the catalog re-serializes, so the
    // emitted order is decided here rather than inherited.
    const parsed = parseModelsDevCatalog({
      opencode: {
        api: "https://opencode.ai/inference/openai/v1",
        models: {
          zulu: {
            id: "zulu",
            name: "Z",
            provider: {
              api: "https://opencode.ai/inference/google/v1beta",
              npm: "@ai-sdk/google",
            },
          },
          alpha: {
            id: "alpha",
            name: "A",
            provider: {
              api: "https://opencode.ai/inference/anthropic",
              npm: "@ai-sdk/anthropic",
            },
          },
        },
      },
    });
    const keys = Object.keys(parsed.familyApi.zen);
    expect(keys).toEqual(keys.toSorted());
  });

  it("is an empty object, not an empty Map, when there is nothing to say", () => {
    // The caller compares this against `{}`, and a Map is a different shape
    // rather than an equal one — a shape difference that reads as a data
    // difference in every `toEqual`.
    expect(parseModelsDevCatalog(null).familyApi.zen).toEqual({});
  });
});
