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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordDebug } from "../src/debug.ts";
import { projectNameFrom } from "../src/stream-hook.ts";
import { collectUnknown, createMockStream } from "./test-helpers.ts";

// The debug sink is observed rather than written: a negative assertion over a
// file needs a wait to mean anything, and a mock makes "never called" exact.
vi.mock("../src/debug.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/debug.ts")>()),
  recordDebug: vi.fn(),
}));

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
  const hookWith = async (
    providers: string[],
    overrides: Record<string, unknown> = {}
  ) => {
    const { createStreamHook } = await import("../src/stream-hook.ts");
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { resolveConfig } = await import("../src/config.ts");
    return createStreamHook(
      { logger: { info: () => {} } } as never,
      resolveConfig({ providers, usageEnabled: false, ...overrides } as never),
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

  it("accepts a numeric provider id, which the seam may carry", async () => {
    // `provider` is `unknown` on the seam; a number is stringified before the
    // allow-list is consulted, and the call still reaches `next`.
    const hook = await hookWith(["7"]);
    const next = vi.fn(() => "next-result");
    expect(hook({ provider: 7, model: "x" }, next)).toBe("next-result");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("stream-hook · the debug gate", () => {
  /**
   * `debug` is the switch and `debugFile` is only where the switch writes. The
   * fetch patch has always been gated that way; the stream hook wrote the file
   * whenever a path was configured, so turning debugging off left one of the two
   * logs running.
   */
  const debugFile = join(tmpdir(), "dsh-stream-debug", "stream.jsonl");

  const hookWith = async (
    debug: boolean,
    file: string | undefined,
    info: (...args: unknown[]) => void
  ) => {
    const { createStreamHook } = await import("../src/stream-hook.ts");
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { resolveConfig } = await import("../src/config.ts");
    return createStreamHook(
      { logger: { info } } as never,
      resolveConfig({
        debug,
        ...(file === undefined ? {} : { debugFile: file }),
        providers: ["opencode"],
        usageEnabled: false,
      } as never),
      new AsyncLocalStorage()
    );
  };

  /** Drive one turn through the hook and drain it. */
  const turn = async (
    debug: boolean,
    {
      info = () => {},
      withFile = true,
    }: {
      info?: (...args: unknown[]) => void;
      withFile?: boolean;
    } = {}
  ): Promise<void> => {
    const hook = await hookWith(debug, withFile ? debugFile : undefined, info);
    const result = hook(
      { model: "m", provider: "opencode", sessionId: "s" },
      () => createMockStream("x")
    );
    await collectUnknown(result as AsyncIterable<unknown>);
  };

  beforeEach(() => {
    vi.mocked(recordDebug).mockClear();
  });

  it("stream-hook · the debug gate: writes nothing to debugFile while debug is off", async () => {
    await turn(false);
    expect(recordDebug).not.toHaveBeenCalled();
  });

  it("writes one entry for the turn to debugFile while debug is on", async () => {
    await turn(true);
    expect(recordDebug).toHaveBeenCalledTimes(1);
    const [, file, entry] = vi.mocked(recordDebug).mock.calls[0] ?? [];
    expect(file).toBe(debugFile);
    expect(entry).toMatchObject({
      header: "x-opencode-session",
      session: "s",
    });
  });

  it("logs the turn but writes no file while debug is on without a debugFile", async () => {
    const info = vi.fn<(...args: unknown[]) => void>();
    await turn(true, { info, withFile: false });
    expect(recordDebug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toContain("x-opencode-session");
  });
});
