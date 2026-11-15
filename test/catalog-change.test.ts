/**
 * The catalog's change signal (`onCatalogChange`, `catalogGeneration`): what
 * the route claim's plane profiles hang off, so a refresh that lands after
 * boot reaches them. Each case performs the refresh it describes.
 *
 * @module test/catalog-change.test
 */
import { describe, expect, it, vi } from "vitest";

import {
  catalogGeneration,
  catalogListenerCount,
  onCatalogChange,
  refreshCatalog,
  resetCatalogState,
} from "./support/src.ts";

/** A fetch answering one catalog payload, or a failure status. */
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    status === 200
      ? Response.json(body)
      : new Response("no", { status })) as unknown as typeof fetch;

const landed = {
  opencode: {
    models: {
      "change-probe-model": {
        name: "Probe",
        provider: { npm: "@ai-sdk/openai" },
      },
    },
  },
};

describe("models-catalog · the change signal", () => {
  it("a listener that throws leaves the refresh a success, and the next listener is still told", async () => {
    const after = vi.fn<() => void>();
    const stopThrowing = onCatalogChange(() => {
      throw new Error("listener failure");
    });
    const stopAfter = onCatalogChange(after);
    try {
      const result = await refreshCatalog(answering(landed), true);
      expect(result.zen.map((model) => model.id)).toContain(
        "change-probe-model"
      );
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      stopThrowing();
      stopAfter();
    }
  });

  it("the unsubscribe removes the listener: a later refresh does not reach it", async () => {
    const before = catalogListenerCount();
    const listener = vi.fn<() => void>();
    const stop = onCatalogChange(listener);
    expect(catalogListenerCount()).toBe(before + 1);
    stop();
    expect(catalogListenerCount()).toBe(before);
    await refreshCatalog(answering(landed), true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("the generation changes on a landed refresh and on a reset, and only then", async () => {
    const listener = vi.fn<() => void>();
    const stop = onCatalogChange(listener);
    try {
      const start = catalogGeneration();
      // A failed read and an empty payload land nothing.
      await refreshCatalog(answering(undefined, 503), true);
      await refreshCatalog(answering({}), true);
      expect(catalogGeneration()).toBe(start);
      expect(listener).not.toHaveBeenCalled();
      await refreshCatalog(answering(landed), true);
      const afterRefresh = catalogGeneration();
      expect(afterRefresh).not.toBe(start);
      expect(listener).toHaveBeenCalledTimes(1);
      resetCatalogState();
      expect(catalogGeneration()).not.toBe(afterRefresh);
    } finally {
      stop();
    }
  });
});
