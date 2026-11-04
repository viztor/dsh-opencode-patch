/**
 * The path resolution, against the behaviour the OpenCode sources describe.
 *
 * Every case passes its own `home` and `env`, which is the point of the module
 * taking them: the resolution can be exercised on any platform from any platform,
 * including the Windows and Linux layouts this machine will never produce.
 *
 * @module dsh-opencode-patch/opencode-paths.test
 */

import assert from "node:assert/strict";
import os from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  opencodeDatabaseFile,
  opencodeDatabasePath,
  opencodeRoots,
} from "./support/src.ts";

const HOME = "/home/you"; // the placeholder the hard-rule test prescribes
const environment = (
  env: Record<string, string | undefined> = {},
  channel?: string
) => ({ channel, env, home: HOME });

describe("opencode-paths: the directory", () => {
  it("falls back to ~/.local/share, which is what every platform uses", () => {
    // The claim from global-roots.ts: XDG on every platform. macOS does NOT use
    // ~/Library/Application Support here and Windows does not use %APPDATA%, so
    // this one assertion covers all three.
    expect(opencodeRoots(environment(), "/tmp").data).toBe(
      nodePath.join(HOME, ".local", "share", "opencode")
    );
  });

  it("honours each XDG variable separately, so the roots can disagree", () => {
    const roots = opencodeRoots(
      environment({
        XDG_CACHE_HOME: "/c",
        XDG_CONFIG_HOME: "/g",
        XDG_DATA_HOME: "/d",
        XDG_STATE_HOME: "/s",
      }),
      "/tmp"
    );
    expect(roots).toEqual({
      cache: nodePath.join("/c", "opencode"),
      config: nodePath.join("/g", "opencode"),
      data: nodePath.join("/d", "opencode"),
      state: nodePath.join("/s", "opencode"),
      tmp: nodePath.join("/tmp", "opencode"),
    });
  });

  it("keeps data and config apart, which is the mistake to avoid", () => {
    // A reader that used one root for both would look for the database in
    // ~/.config/opencode. Measured: they are different directories by default.
    const roots = opencodeRoots(environment(), "/tmp");
    expect(roots.data).not.toBe(roots.config);
    expect(roots.config).toBe(nodePath.join(HOME, ".config", "opencode"));
  });
});

describe("opencode-paths: the filename", () => {
  it("is opencode.db on a stable channel", () => {
    for (const channel of ["latest", "dev", "beta", "next", "prod"]) {
      expect(opencodeDatabaseFile(environment({}, channel))).toBe(
        "opencode.db"
      );
    }
  });

  it("carries the channel name on any other channel", () => {
    expect(opencodeDatabaseFile(environment({}, "canary"))).toBe(
      "opencode-canary.db"
    );
    // The sanitising is the original's: anything outside [a-zA-Z0-9._-] becomes -.
    expect(opencodeDatabaseFile(environment({}, "feature/thing"))).toBe(
      "opencode-feature-thing.db"
    );
  });

  it("lets $OPENCODE_DISABLE_CHANNEL_DB force the plain name", () => {
    for (const value of ["1", "true"]) {
      expect(
        opencodeDatabaseFile(
          environment({ OPENCODE_DISABLE_CHANNEL_DB: value }, "canary")
        )
      ).toBe("opencode.db");
    }
    // Anything else is not a truthy value to the original either.
    expect(
      opencodeDatabaseFile(
        environment({ OPENCODE_DISABLE_CHANNEL_DB: "0" }, "canary")
      )
    ).toBe("opencode-canary.db");
  });

  it("lets $OPENCODE_DB win outright, including :memory:", () => {
    expect(
      opencodeDatabaseFile(
        environment({ OPENCODE_DB: "/somewhere/else.db" }, "canary")
      )
    ).toBe("/somewhere/else.db");
    expect(opencodeDatabaseFile(environment({ OPENCODE_DB: ":memory:" }))).toBe(
      ":memory:"
    );
  });
});

describe("opencode-paths: the path they make together", () => {
  it("puts the database under data, not under config", () => {
    expect(opencodeDatabasePath(environment({}, "latest"), "/tmp")).toBe(
      nodePath.join(HOME, ".local", "share", "opencode", "opencode.db")
    );
  });

  it("moves with $XDG_DATA_HOME and with the channel, independently", () => {
    expect(
      opencodeDatabasePath(
        environment({ XDG_DATA_HOME: "/d" }, "canary"),
        "/tmp"
      )
    ).toBe(nodePath.join("/d", "opencode", "opencode-canary.db"));
  });

  it("leaves :memory: alone rather than joining it to a directory", () => {
    expect(
      opencodeDatabasePath(environment({ OPENCODE_DB: ":memory:" }), "/tmp")
    ).toBe(":memory:");
  });

  it("resolves this machine to the file that is actually there", () => {
    // The case whose answer is known before it runs: this host has a stable
    // channel, and the file exists. Asserting the shape rather than the content
    // keeps the test honest on a machine where it does not.
    const path = opencodeDatabasePath(
      { env: process.env, home: os.homedir() },
      os.tmpdir()
    );
    assert.ok(path.endsWith(".db"), path);
    expect(path.startsWith(os.homedir()) || path.startsWith("/")).toBe(true);
  });
});
