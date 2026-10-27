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
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveTurnState,
  createStreamHook,
  getSessionUsage,
  openCodeSessionIdFor,
  projectNameFrom,
  recordDebug,
  resolveConfig,
} from "./support/src.ts";
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

  it("answers the folder when the repository root's own name is blank", () => {
    // A root whose name trims to nothing names nothing: the walk stops there
    // and the folder itself is the attribution, never an empty header.
    const outer = tree();
    const blankRoot = join(outer, " ");
    mkdirSync(join(blankRoot, ".git"), { recursive: true });
    const sub = join(blankRoot, "inside");
    mkdirSync(sub);
    expect(projectNameFrom(sub)).toBe("inside");
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
  ) =>
    createStreamHook(
      { logger: { info: () => {} } } as never,
      resolveConfig({ providers, usageEnabled: false, ...overrides } as never),
      new AsyncLocalStorage()
    );

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
  ) =>
    createStreamHook(
      { logger: { info } } as never,
      resolveConfig({
        debug,
        ...(file === undefined ? {} : { debugFile: file }),
        providers: ["opencode"],
        usageEnabled: false,
      } as never),
      new AsyncLocalStorage()
    );

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

describe("stream-hook · what a turn carries", () => {
  /**
   * The hook driven with a test-owned store, so what the turn hands the fetch
   * patch is read where the fetch patch reads it: inside the stream.
   */
  const als = new AsyncLocalStorage<ActiveTurnState>();

  const hookOn = (
    ctx: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {}
  ) =>
    createStreamHook(
      { logger: { info: () => {} }, ...ctx } as never,
      resolveConfig({
        providers: ["opencode"],
        usageEnabled: false,
        ...overrides,
      } as never),
      als
    );

  /**
   * A downstream that yields the store it ran under, once.
   *
   * @yields {ActiveTurnState | undefined} the turn store.
   */
  const storeReader = async function* storeReader() {
    yield als.getStore();
  };

  /** A Host session service answering for one id. */
  const sessionsFor = (id: string, header: Record<string, unknown>) => ({
    get: (name: string) =>
      name === "sessions"
        ? { get: (asked: string) => (asked === id ? { header } : undefined) }
        : undefined,
  });

  const storeOf = async (stream: unknown): Promise<ActiveTurnState> => {
    const [store] = await collectUnknown(stream as AsyncIterable<unknown>);
    return store as ActiveTurnState;
  };

  beforeEach(() => {
    vi.mocked(recordDebug).mockClear();
  });

  it("a numeric sessionId and a numeric parentSessionId are stringified before derivation", async () => {
    const store = await storeOf(
      hookOn()(
        { model: "m", parentSessionId: 9, provider: "opencode", sessionId: 7 },
        storeReader
      )
    );
    expect(store.value).toBe(openCodeSessionIdFor("7"));
    expect(store.parentValue).toBe(openCodeSessionIdFor("9"));
  });

  it("a session whose cwd is the filesystem root carries no project", async () => {
    const store = await storeOf(
      hookOn(sessionsFor("rooted", { cwd: "/" }))(
        { model: "m", provider: "opencode", sessionId: "rooted" },
        storeReader
      )
    );
    expect(store.value).toBe(openCodeSessionIdFor("rooted"));
    expect(store.project).toBeUndefined();
  });

  it("the debug entry carries the parent's derived id and the project", async () => {
    const debugFile = join(tmpdir(), "dsh-stream-debug", "parent.jsonl");
    await storeOf(
      hookOn(sessionsFor("child", { cwd: "/home/you/projects/my-app" }), {
        debug: true,
        debugFile,
      })(
        {
          model: "m",
          parentSessionId: "parent",
          provider: "opencode",
          sessionId: "child",
        },
        storeReader
      )
    );
    expect(recordDebug).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(recordDebug).mock.calls[0]?.[2];
    expect(entry).toMatchObject({
      parentSession: openCodeSessionIdFor("parent"),
      project: "my-app",
      session: "child",
      value: openCodeSessionIdFor("child"),
    });
  });

  it("a model that is not a string is recorded as no model at all", async () => {
    const [, store] = await collectUnknown(
      hookOn()(
        { model: 42, provider: "opencode", sessionId: "no-model" },
        async function* usageThenStore() {
          yield { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } };
          yield als.getStore();
        }
      ) as AsyncIterable<unknown>
    );
    expect((store as ActiveTurnState).model).toBeUndefined();
    const usage = getSessionUsage("no-model");
    expect(usage?.turns).toBe(1);
    // "unknown" is the accumulator's word for no model: never an active one.
    expect(usage?.activeModel).toBeUndefined();
    expect(usage?.modelsUsed).toEqual([]);
  });

  it("a usage chunk carrying only cacheReadTokens is recorded with the other counters absent", async () => {
    await collectUnknown(
      hookOn()(
        { model: "m", provider: "opencode", sessionId: "cache-only" },
        async function* cacheOnly() {
          yield {
            type: "usage",
            usage: { cacheReadTokens: 12, inputTokens: "x" },
          };
        }
      ) as AsyncIterable<unknown>
    );
    const usage = getSessionUsage("cache-only");
    expect(usage).toMatchObject({
      cacheReadTokens: 12,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 1,
    });
  });
});
