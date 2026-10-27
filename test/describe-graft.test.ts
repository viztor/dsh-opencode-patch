/**
 * The Settings graft (`src/host/describe-graft.ts`, D18): pi-ai's displayed
 * value gets the committed plane entries back, and nothing else moves.
 *
 * @module test/describe-graft.test
 */
import { describe, expect, it } from "vitest";

import {
  type CordisContext,
  graftPlaneEntries,
  installDescribeGraft,
} from "./support/src.ts";

describe("describe-graft · graftPlaneEntries", () => {
  it("fills only the missing planes of the llm-pi-ai value and touches nothing else", () => {
    const base = { providers: { deepseek: { b: 1 } } };
    const user = { providers: { opencode: { u: 1 } } };
    const other = { ns: "other", value: {} };
    const piAi = {
      base,
      ns: "llm-pi-ai",
      revision: 3,
      user,
      value: { other: true, providers: { deepseek: {} } },
    };
    const input: unknown[] = [piAi, other];
    const entry = { apiKeyEnv: "OPENCODE_API_KEY" };
    const out = graftPlaneEntries(input, "llm-pi-ai", {
      opencode: entry,
    }) as [typeof piAi, typeof other];
    expect(out[0]?.value).toEqual({
      other: true,
      providers: { deepseek: {}, opencode: entry },
    });
    expect(out[0]?.base).toBe(base);
    expect(out[0]?.user).toBe(user);
    expect(out[0]?.revision).toBe(3);
    expect(out[1]).toBe(other);
    expect(piAi.value.providers).not.toHaveProperty("opencode");
  });

  it("leaves a plane the value already holds as it was, and a descriptor with nothing to add as the same object", () => {
    const held = { mine: true };
    const descriptor = {
      ns: "llm-pi-ai",
      value: { providers: { opencode: held } },
    };
    const [out] = graftPlaneEntries([descriptor], "llm-pi-ai", {
      opencode: { theirs: true },
    }) as [typeof descriptor];
    expect(out).toBe(descriptor);
    expect(out.value.providers.opencode).toBe(held);
    // With no committed entries there is nothing to graft.
    const [same] = graftPlaneEntries([descriptor], "llm-pi-ai", {}) as [
      typeof descriptor,
    ];
    expect(same).toBe(descriptor);
  });

  it("takes the namespace from its argument, so a row with another id works, and tolerates shapes it does not know", () => {
    const [out] = graftPlaneEntries([{ ns: "llm", value: {} }], "llm", {
      "opencode-go": { a: 1 },
    }) as [{ value: { providers: object } }];
    expect(out.value.providers).toEqual({ "opencode-go": { a: 1 } });
    expect(graftPlaneEntries("nope", "llm-pi-ai", {})).toBe("nope");
    const odd = [null, { ns: "llm-pi-ai" }, { ns: "llm-pi-ai", value: 5 }];
    expect(graftPlaneEntries(odd, "llm-pi-ai", { opencode: {} })).toEqual(odd);
  });
});

describe("describe-graft · installDescribeGraft", () => {
  /** A stand-in whose `inject` hands over a settings scope, recording effects. */
  const host = (settings?: object) => {
    const cleanups: (() => void)[] = [];
    const ctx = {
      inject: (_deps: string[], callback: (scope: unknown) => void) => {
        callback({
          effect: (fn: () => unknown) => {
            const cleanup = fn();
            if (typeof cleanup === "function") {
              cleanups.push(cleanup as () => void);
            }
          },
          settings,
        });
      },
    } as unknown as CordisContext;
    return { cleanups, ctx };
  };

  it("wraps describe through patchMethod, and its dispose restores the own descriptor exactly", () => {
    const unwrapped = (): unknown => [
      { ns: "llm-pi-ai", value: { providers: {} } },
    ];
    const settings = { describe: unwrapped };
    const original = Reflect.getOwnPropertyDescriptor(settings, "describe");
    const { cleanups, ctx } = host(settings);
    installDescribeGraft(ctx, {
      committedEntries: () => ({ opencode: { a: 1 } }),
      piAiNamespace: () => "llm-pi-ai",
    });
    expect(settings.describe).not.toBe(unwrapped);
    expect(settings.describe()).toEqual([
      { ns: "llm-pi-ai", value: { providers: { opencode: { a: 1 } } } },
    ]);
    expect(cleanups).toHaveLength(1);
    cleanups[0]?.();
    expect(Reflect.getOwnPropertyDescriptor(settings, "describe")).toEqual(
      original
    );
  });

  it("stands down without a settings service, and on an inherited describe leaves no own property after dispose", () => {
    const empty = host();
    installDescribeGraft(empty.ctx, {
      committedEntries: () => ({}),
      piAiNamespace: () => "llm-pi-ai",
    });
    expect(empty.cleanups).toEqual([]);
    class Settings {
      describe(): unknown {
        return [];
      }
    }
    const settings = new Settings();
    const { cleanups, ctx } = host(settings);
    installDescribeGraft(ctx, {
      committedEntries: () => ({}),
      piAiNamespace: () => "llm-pi-ai",
    });
    expect(Object.hasOwn(settings, "describe")).toBe(true);
    cleanups[0]?.();
    expect(Object.hasOwn(settings, "describe")).toBe(false);
    // A context without `inject` installs nothing and does not throw.
    expect(() =>
      installDescribeGraft({} as CordisContext, {
        committedEntries: () => ({}),
        piAiNamespace: () => "llm-pi-ai",
      })
    ).not.toThrow();
  });
});
