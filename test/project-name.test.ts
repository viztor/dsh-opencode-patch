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

import { describe, expect, it } from "vitest";

import { projectNameFrom } from "../src/stream-hook.ts";

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
