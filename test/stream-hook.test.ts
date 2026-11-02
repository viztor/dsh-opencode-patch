/**
 * `projectNameFrom`: the name a session's requests carry as their project.
 *
 * This is an ATTRIBUTION header, and two properties matter more than the happy
 * path. It must never leak a local path (the repo's hard rule — and the path
 * carries the username), and it must name the REPOSITORY rather than the folder,
 * or two sessions in one workspace report two names and the attribution stops
 * meaning anything.
 *
 * The filesystem cases use real temp directories: the walk asks `existsSync`, so
 * a mocked one would prove only that the mock was called.
 *
 * @module test/stream-hook.test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { projectNameFrom } from "../src/stream-hook.ts";

const created: string[] = [];

/** A throwaway directory tree, removed after the test. */
const tree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dsh-project-name-"));
  created.push(root);
  return root;
};

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("stream-hook · projectNameFrom names the repository", () => {
  it("answers the folder itself when no repository encloses it", () => {
    const root = tree();
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(projectNameFrom(plain)).toBe("not-a-repo");
  });

  it("walks UP to the repository root from a subdirectory", () => {
    // The attribution rule: a session in /repo/packages/foo and one in /repo are
    // working in the same place, and must report one name.
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const deep = join(repo, "packages", "foo");
    mkdirSync(deep, { recursive: true });
    const expected = basename(repo);
    expect(projectNameFrom(deep)).toBe(expected);
    expect(projectNameFrom(repo)).toBe(expected);
  });

  it("treats a Mercurial checkout as a repository too", () => {
    // A repository is not necessarily git.
    const repo = tree();
    mkdirSync(join(repo, ".hg"));
    const sub = join(repo, "src");
    mkdirSync(sub);
    expect(projectNameFrom(sub)).toBe(basename(repo));
  });

  it("splits on BOTH separators, so a Windows path is named correctly", () => {
    // `path.basename` is platform-specific: on POSIX it returns a whole
    // `C:\Users\you\proj` unchanged, which would send a username out.
    expect(projectNameFrom("C:\\Users\\you\\my-project")).toBe("my-project");
    expect(projectNameFrom("/home/you/my-project")).toBe("my-project");
    expect(projectNameFrom("C:/Users/you/mixed")).toBe("mixed");
  });

  it("trims trailing separators and blanks", () => {
    expect(projectNameFrom("/home/you/proj///")).toBe("proj");
    expect(projectNameFrom("/home/you/  spaced  /")).toBe("spaced");
  });

  it("answers undefined when the path names no folder", () => {
    // A cwd with no usable last segment has no project to report — and `""`,
    // `"."` and `".."` are not names.
    for (const odd of ["", "/", "///", ".", "..", "/home/you/..", "   "]) {
      expect(projectNameFrom(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it("never returns a path, only a basename", () => {
    // The hard rule: a local path must not leave the machine. A `/` in the
    // answer would mean the whole path went out.
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    const answer = projectNameFrom(join(repo, "a", "b"));
    expect(answer).toBeDefined();
    expect(answer).not.toContain("/");
  });

  it("reports the root even when the marker sits beside a file", () => {
    // `.git` is a DIRECTORY, but a worktree checkout uses a `.git` FILE. Both
    // mean "repository root", and the walk only asks whether the entry exists.
    const repo = tree();
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(repo, "src"));
    expect(projectNameFrom(join(repo, "src"))).toBe(basename(repo));
  });
});

describe("stream-hook · the pass-through guards", () => {
  /**
   * The hook runs on EVERY request, so anything it does not serve must reach
   * `next()` untouched and immediately. These cases are the boundaries: a
   * mistyped options object, a provider it does not own, and a model it cannot
   * serve.
   */
  const hookWith = async (providers: string[]) => {
    const { createStreamHook } = await import("../src/stream-hook.ts");
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { resolveConfig } = await import("../src/config.ts");
    return createStreamHook(
      { logger: { info: () => {} } } as never,
      resolveConfig({ providers, usageEnabled: false } as never),
      new AsyncLocalStorage()
    );
  };

  it("hands through anything that is not an options object", async () => {
    const hook = await hookWith(["opencode"]);
    for (const options of [undefined, null, "opts", 42, true]) {
      const next = vi.fn(() => "next-result");
      expect(hook(options, next)).toBe("next-result");
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("hands through a request with no usable provider", async () => {
    const hook = await hookWith(["opencode"]);
    for (const provider of [undefined, null, {}, [], true, () => {}]) {
      const next = vi.fn(() => "next-result");
      expect(hook({ provider }, next)).toBe("next-result");
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("hands through a provider this plugin does not own", async () => {
    const hook = await hookWith(["opencode"]);
    const next = vi.fn(() => "next-result");
    expect(hook({ provider: "somebody-else", model: "x" }, next)).toBe(
      "next-result"
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("says WHY a model cannot be served, instead of leaving the picker empty", async () => {
    // The diagnostic a reader gets when a model they declared is filtered out.
    // The three reasons are checked in the order the filter applies them, so the
    // sentence names the decision that actually fired — naming a protocol for a
    // model filtered on its tier sends the reader to the routing table for an
    // entitlement problem.
    //
    // `@ai-sdk/mistral` is the reachable case: the catalogue carries one such
    // model and `isServableSdk` keeps it out of every picker, deliberately.
    const hook = await hookWith(["opencode"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const next = vi.fn(() => "next-result");
      expect(
        hook({ model: "mistral-large-4", provider: "opencode" }, next)
      ).toBe("next-result");
      expect(next).toHaveBeenCalledTimes(1);
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("opencode/mistral-large-4 cannot be served");
      expect(said).toContain("@ai-sdk/mistral");
      // And once per pair: the hook runs on every request, and the same missing
      // route must not warn on each one.
      hook({ model: "mistral-large-4", provider: "opencode" }, next);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a numeric provider id, which the seam may carry", async () => {
    // `provider` is `unknown` on the seam; a number is stringified before the
    // allow-list is consulted, and the call still reaches `next`.
    const hook = await hookWith(["7"]);
    const next = vi.fn(() => "next-result");
    expect(hook({ provider: 7, model: "x" }, next)).toBe("next-result");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("stream-hook · a turn is priced at ITS plane's rate", () => {
  /**
   * The two planes price the same id differently, and the plane-agnostic
   * catalog lookup searches Go FIRST — so a Zen turn was priced at the Go rate.
   *
   * `deepseek-v4.1-flash` costs $0.30 per million input tokens on Zen and
   * $0.15 on Go: a Zen turn came out at exactly half of what it cost, and the
   * meter showed the half.
   */
  const hookWith = async (providers: string[]) => {
    const { createStreamHook } = await import("../src/stream-hook.ts");
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { resolveConfig } = await import("../src/config.ts");
    return createStreamHook(
      { logger: { info: () => {} } } as never,
      resolveConfig({ providers, usageEnabled: true } as never),
      new AsyncLocalStorage()
    );
  };

  /**
   * A stream that reports one turn's usage, the way the gateway reports it.
   *
   * @yields {unknown} one usage chunk
   */
  const usageStream = async function* usageStream() {
    yield {
      type: "usage",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
    };
  };

  it("prices a Zen turn at the Zen rate, and a Go turn at the Go rate", async () => {
    const { clearSessionUsageStore, getSessionUsage } =
      await import("../src/session-cost.ts");
    clearSessionUsageStore();
    const hook = await hookWith(["opencode", "opencode-go"]);

    // One million input tokens: $0.30 on Zen, $0.15 on Go.
    for (const [provider, sessionId, expected] of [
      ["opencode", "s-zen", 0.3],
      ["opencode-go", "s-go", 0.15],
    ] as const) {
      const result = hook(
        {
          model: "deepseek-v4.1-flash",
          provider,
          sessionId,
        },
        () => usageStream()
      );
      // The hook returns the downstream's value, and the usage is recorded while
      // the stream is consumed.
      for await (const _chunk of result as AsyncGenerator) {
        void _chunk;
      }
      const snapshot = getSessionUsage(sessionId);
      expect(snapshot?.costUsd, `${provider} priced a Zen-rate turn`).toBe(
        expected
      );
    }
    clearSessionUsageStore();
  });
});
