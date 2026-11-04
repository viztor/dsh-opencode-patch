import { mkdirSync, mkdtempSync } from "node:fs";
/**
 * projectNameFrom — the value behind `x-opencode-project`.
 *
 * This is a PRIVACY boundary, not a formatting detail: whatever this returns
 * is sent to the gateway on every turn, so a path that is not split would leak
 * a username and a directory layout. `path.basename` cannot be used for it —
 * it is platform-specific, and a Windows-shaped path on a POSIX host comes
 * back unsplit.
 *
 * @module test/project-name.test
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectNameFrom } from "./support/src.ts";

describe("projectNameFrom", () => {
  it("takes the folder name from a POSIX path", () => {
    expect(projectNameFrom("/home/you/projects/my-app")).toBe("my-app");
  });

  it("takes the folder name from a Windows path, on any host", () => {
    // The regression: `path.basename` returns the WHOLE string here on POSIX.
    expect(projectNameFrom("C:\\Users\\you\\projects\\my-app")).toBe("my-app");
    expect(projectNameFrom("C:/Users/you/projects/my-app")).toBe("my-app");
  });

  it("ignores trailing separators", () => {
    expect(projectNameFrom("/home/you/projects/my-app/")).toBe("my-app");
    expect(projectNameFrom("C:\\Users\\you\\projects\\my-app\\")).toBe(
      "my-app"
    );
  });

  it("NEVER returns anything containing a separator", () => {
    for (const input of [
      "/home/you/projects/my-app",
      "C:\\Users\\you\\projects\\my-app",
      "/a/b/c/d/e",
      "C:/x/y/z",
      "/",
      ".",
      "..",
      "",
      "   ",
    ]) {
      const name = projectNameFrom(input);
      if (name !== undefined) {
        expect(name).not.toMatch(/[\\/]/);
      }
    }
  });

  it("returns nothing when the path names no folder", () => {
    for (const input of ["/", ".", "..", "", "   ", "///"]) {
      expect(projectNameFrom(input)).toBeUndefined();
    }
  });
});

// The repository root, not the folder the session started in.
//
// OpenCode's project id resolves up to the version-control root and strips the
// marker - `.git` or `.hg`, both, because a repository is not necessarily git -
// so a subdirectory and the root itself report the same workspace, and a
// worktree reports its main repository (`packages/core/src/project.ts:52,
// 307-315, 356-376`). Taking the cwd's own last segment made
// `/repo/packages/foo` report `foo` while `/repo` reported `repo`: two names
// for one workspace, which is the attribution the header exists for.
describe("projectNameFrom reports the repository, not the session's folder", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-proj-"));
  const nested = join(root, "packages", "foo");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(root, ".git"));

  it("gives one name for the root and for a directory inside it", () => {
    expect(projectNameFrom(root)).toBe(basename(root));
    expect(projectNameFrom(nested)).toBe(basename(root));
  });

  it("falls back to the folder when the tree is not a repository", () => {
    const bare = mkdtempSync(join(tmpdir(), "oc-bare-"));
    expect(projectNameFrom(bare)).toBe(basename(bare));
  });
});
