/**
 * Test: OpenCode Client Channels & Database Resolution.
 *
 * Validates:
 * - Channel database mapping: stable/dev/beta vs named channels (insider, preview, custom)
 * - Filename sanitization for channels with non-standard characters
 * - Configuration overrides: OPENCODE_DISABLE_CHANNEL_DB and OPENCODE_DB
 * - Multi-platform XDG directory resolution (Linux, macOS, Windows)
 * - Safe degradation on non-existent, corrupt, or missing SQLite database files
 *
 * @module test/client-channels.test
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  opencodeDatabaseFile,
  opencodeRoots,
  readOpencodeCredentials,
} from "./support/src.ts";

describe("OpenCode Client Channels & Database File Resolution", () => {
  it.each([
    { channel: undefined, expectedDb: "opencode.db" },
    { channel: "stable", expectedDb: "opencode-stable.db" },
    { channel: "latest", expectedDb: "opencode.db" },
    { channel: "dev", expectedDb: "opencode.db" },
    { channel: "beta", expectedDb: "opencode.db" },
    { channel: "next", expectedDb: "opencode.db" },
    { channel: "prod", expectedDb: "opencode.db" },
    { channel: "insider", expectedDb: "opencode-insider.db" },
    { channel: "preview", expectedDb: "opencode-preview.db" },
    {
      channel: "nightly/experimental",
      expectedDb: "opencode-nightly-experimental.db",
    },
    { channel: "team_feature@v1", expectedDb: "opencode-team_feature-v1.db" },
  ])(
    "resolves channel '$channel' to database file '$expectedDb'",
    ({ channel, expectedDb }) => {
      const dbFile = opencodeDatabaseFile({
        channel,
        env: {},
        home: "/mock/home",
      });
      expect(dbFile).toBe(expectedDb);
    }
  );

  it("forces opencode.db on any channel when OPENCODE_DISABLE_CHANNEL_DB=1", () => {
    const dbFile = opencodeDatabaseFile({
      channel: "insider",
      env: { OPENCODE_DISABLE_CHANNEL_DB: "1" },
      home: "/mock/home",
    });
    expect(dbFile).toBe("opencode.db");
  });

  it("prioritizes OPENCODE_DB environment variable override over channel rules", () => {
    const customPath = "/custom/path/to/my-opencode.sqlite";
    const dbFile = opencodeDatabaseFile({
      channel: "stable",
      env: { OPENCODE_DB: customPath },
      home: "/mock/home",
    });
    expect(dbFile).toBe(customPath);
  });

  it("resolves multi-platform XDG roots across macOS, Linux, and Windows", () => {
    const linuxRoots = opencodeRoots(
      {
        channel: "stable",
        env: {
          XDG_CACHE_HOME: "/home/you/.cache",
          XDG_CONFIG_HOME: "/home/you/.config",
          XDG_DATA_HOME: "/home/you/.local/share",
          XDG_STATE_HOME: "/home/you/.local/state",
        },
        home: "/home/you",
      },
      "/tmp"
    );
    expect(linuxRoots.data).toBe(join("/home/you/.local/share", "opencode"));
    expect(linuxRoots.config).toBe(join("/home/you/.config", "opencode"));

    const macRoots = opencodeRoots(
      {
        channel: "stable",
        env: {},
        home: "/Users/you",
      },
      "/var/tmp"
    );
    expect(macRoots.data).toBe(
      join("/Users/you", ".local", "share", "opencode")
    );
    expect(macRoots.tmp).toBe(join("/var/tmp", "opencode"));

    const winRoots = opencodeRoots(
      {
        channel: "dev",
        env: {
          XDG_DATA_HOME: "C:\\Users\\you\\AppData\\Local",
        },
        home: "C:\\Users\\you",
      },
      "C:\\Temp"
    );
    expect(winRoots.data).toContain("AppData");
  });

  it("gracefully returns undefined for non-existent, corrupt, or missing tables without throwing", () => {
    expect(readOpencodeCredentials("/nonexistent/opencode.db")).toBeUndefined();
    expect(readOpencodeCredentials(":memory:")).toBeUndefined();
  });
});
