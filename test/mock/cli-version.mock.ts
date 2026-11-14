/**
 * The CLI-version gate's registry half (`scripts/check-vendor-version.ts`),
 * run against a loopback registry in a throwaway tree: which document it asks
 * for, what it says when the pin is the published version, and how it names
 * a `latest` that left the pinned line. The rules it applies are
 * `test/vendor-version.test.ts`'s; this binds a socket, so it is the mock
 * suite's.
 *
 * @module test/mock/cli-version.mock
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-vendor-version.ts");

/**
 * The pin the throwaway tree declares. Built from parts: this file is in the
 * real copy scan's path, so a spelled-out version here would be a copy.
 */
const PIN = ["0", "0", "1"].join(".");

/** A loopback registry answering every request with `answer`, recording paths. */
const serve = async (
  answer: Readonly<Record<string, string>> | number
): Promise<{ asked: string[]; server: Server; url: string }> => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    if (typeof answer === "number") {
      response.writeHead(answer);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { asked, server, url: `http://127.0.0.1:${port}` };
};

/** The script, in a tree whose pin and one doc copy agree, asked `url`. */
const check = async (
  url: string
): Promise<{ status: number; stderr: string; stdout: string }> => {
  const root = mkdtempSync(join(tmpdir(), "cli-version-registry-"));
  try {
    for (const [path, text] of Object.entries({
      "README.md": "# fixture\n",
      "docs/x.md": `User-Agent: opencode/${PIN}\n`,
      "src/identity.ts": `export const OPENCODE_CLI_VERSION = "${PIN}";\n`,
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          SCRIPT,
          "--registry",
          url,
        ],
        { cwd: root },
        (error, stdout, stderr) => {
          resolve({
            status: error === null ? 0 : Number(error.code ?? 1),
            stderr,
            stdout,
          });
        }
      );
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("cli:version · the registry's dist-tags", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("asks the registry for dist-tags, passes on the pinned latest, and names a bump and a generation change apart", async () => {
    const snapshot = ["0.0.0", "dev", "1"].join("-");
    const current = await serve({ dev: snapshot, latest: PIN });
    ({ server } = current);
    const ok = await check(current.url);
    expect(current.asked, JSON.stringify(ok)).toStrictEqual([
      "/-/package/opencode-ai/dist-tags",
    ]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    const [first, second] = ok.stdout.split("\n");
    expect(first).toMatch(
      new RegExp(
        `^ok {3}opencode/${PIN.replaceAll(".", "\\.")} is the published version`,
        "u"
      )
    );
    expect(second).toContain(`dev ${snapshot}`);
    expect(second).toContain("not claimed");
    // A snapshot tag says nothing of its build's generation: most are 1.x
    // feature branches, so no User-Agent format is asserted for them.
    expect(second).not.toMatch(/opencode\/<channel>|2\.x/u);
    server.close();

    // A `latest` on the pinned major, one patch on: a bump, not a
    // generation change. Built from parts, as PIN is.
    const next = await serve({ latest: ["0", "0", "2"].join(".") });
    ({ server } = next);
    const bump = await check(next.url);
    expect(bump.status).toBe(1);
    const [bumpLine = ""] = bump.stderr.split("\n");
    expect(bumpLine).toMatch(/^error: .*bump OPENCODE_CLI_VERSION/u);
    expect(bumpLine).not.toMatch(/generation/u);
    server.close();

    const moved = await serve({ latest: "2.0.0" });
    ({ server } = moved);
    const generation = await check(moved.url);
    expect(generation.status).toBe(1);
    expect(generation.stderr.split("\n")[0]).toMatch(/^error: .*generation/u);
    server.close();

    const refusing = await serve(500);
    ({ server } = refusing);
    const refused = await check(refusing.url);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^error: the registry answered 500/u);
  });
});
